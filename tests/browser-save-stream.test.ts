import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

const script = readFileSync(
  new URL("../public/browser-save-sw.js", import.meta.url),
  "utf8"
)

function downloadStream() {
  const listeners = new Map<string, (event: unknown) => void>()
  const origin = "https://save.test"
  const id = "11111111-1111-4111-8111-111111111111"
  const channel = new MessageChannel()
  const messages: { type: string; sequence?: number }[] = []
  channel.port1.onmessage = (event) => messages.push(event.data)
  runInNewContext(script, {
    self: {
      location: { origin },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
    },
    URL,
    Response,
    ReadableStream,
    Uint8Array,
    setTimeout,
    clearTimeout,
  })
  const message = (data: { type: string; id: string; filename?: string }) =>
    listeners.get("message")!({
      data,
      ports: data.type === "register-save" ? [channel.port2] : [],
      source: { id: "synthetic-client" },
    })
  message({ type: "register-save", id, filename: "synthetic.bin" })
  let response!: Response
  listeners.get("fetch")!({
    request: { url: `${origin}/local-saves/${id}/synthetic.bin` },
    respondWith: (value: Response) => {
      response = value
    },
  })
  return {
    port: channel.port1,
    messages,
    reader: response.body!.getReader(),
    release() {
      message({ type: "release-save", id })
      channel.port1.close()
      channel.port2.close()
    },
  }
}

describe("streaming download writer handoff", () => {
  it("retains first demand while the started port is delayed and transferred", async () => {
    const stream = downloadStream()
    let writer: MessagePort | undefined
    const firstRead = stream.reader.read()
    void firstRead.catch(() => {})
    try {
      await vi.waitFor(() =>
        expect(stream.messages).toContainEqual({ type: "started" })
      )
      // The page's already-started port continues dispatching during Worker
      // startup. No write credit may be dispatched to that temporary consumer.
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(stream.messages.filter((value) => value.type === "pull")).toEqual(
        []
      )
      writer = structuredClone(
        { port: stream.port },
        { transfer: [stream.port] }
      ).port as MessagePort
      const received: { type: string; sequence?: number }[] = []
      writer.onmessage = (event) => received.push(event.data)
      writer.start()
      writer.postMessage({ type: "writer-ready" })
      writer.postMessage({ type: "writer-ready" })
      await vi.waitFor(() =>
        expect(received.filter((value) => value.type === "pull")).toHaveLength(
          1
        )
      )
      const bytes = new Uint8Array([1, 2, 3, 4])
      writer.postMessage({ type: "chunk", sequence: 1, bytes: bytes.buffer }, [
        bytes.buffer,
      ])
      expect(await firstRead).toEqual({
        done: false,
        value: new Uint8Array([1, 2, 3, 4]),
      })
      await vi.waitFor(() =>
        expect(received).toContainEqual({ type: "ack", sequence: 1 })
      )
      expect(received.filter((value) => value.type === "pull")).toHaveLength(1)
      const secondRead = stream.reader.read()
      void secondRead.catch(() => {})
      await vi.waitFor(() =>
        expect(received.filter((value) => value.type === "pull")).toHaveLength(
          2
        )
      )
      writer.postMessage({ type: "close" })
      expect(await secondRead).toEqual({ done: true, value: undefined })
      await vi.waitFor(() =>
        expect(received).toContainEqual({ type: "closed" })
      )
    } finally {
      stream.release()
      writer?.close()
    }
  })

  it("waits for actual demand even when writer readiness arrives first", async () => {
    const stream = downloadStream()
    try {
      stream.port.postMessage({ type: "writer-ready" })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(stream.messages.filter((value) => value.type === "pull")).toEqual(
        []
      )
      const pending = stream.reader.read()
      void pending.catch(() => {})
      await vi.waitFor(() =>
        expect(
          stream.messages.filter((value) => value.type === "pull")
        ).toHaveLength(1)
      )
      stream.port.postMessage({ type: "writer-ready" })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(
        stream.messages.filter((value) => value.type === "pull")
      ).toHaveLength(1)
      await stream.reader.cancel()
      await pending
      await vi.waitFor(() =>
        expect(stream.messages).toContainEqual({ type: "cancel" })
      )
    } finally {
      stream.release()
    }
  })
})
