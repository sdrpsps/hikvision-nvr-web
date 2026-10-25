import { afterEach, describe, expect, it, vi } from "vitest"
import {
  chooseDestination,
  releaseDestination,
} from "../lib/browser-save/destination"

const id = "11111111-1111-4111-8111-111111111111"
const ports: MessagePort[] = []

class SaveWorker extends EventTarget {
  state: ServiceWorkerState = "activated"
  acknowledge = true
  protocol: number | undefined = 2
  emulateSafariTransferredClose = false
  donorClosed = vi.fn()
  port?: MessagePort
  postMessage = vi.fn(
    (message: { type: string }, transfer?: Transferable[]) => {
      if (message.type === "register-save") {
        // Preserve actual MessagePort transfer semantics, including the
        // sender-side port becoming unusable after successful handoff.
        const donor = transfer![0] as MessagePort
        const value = structuredClone(
          { port: donor },
          { transfer: transfer! }
        ) as { port: MessagePort }
        if (this.emulateSafariTransferredClose)
          vi.spyOn(donor, "close").mockImplementation(() => {
            // Native Safari can close the receiving endpoint when the old
            // transferred handle is closed after registration acknowledgment.
            this.donorClosed()
            value.port.close()
          })
        this.port = value.port
        ports.push(value.port)
        if (this.acknowledge)
          value.port.postMessage({
            type: "registered",
            ...(this.protocol === undefined ? {} : { protocol: this.protocol }),
          })
      }
      if (message.type === "release-save") {
        this.port?.postMessage({ type: "cancel" })
        this.port?.close()
      }
    }
  )
}

function environment(worker: SaveWorker, oldWorker?: SaveWorker) {
  const register = vi.fn(async () => ({
    active: oldWorker ?? worker,
    installing: oldWorker ? worker : null,
    waiting: null,
  }))
  const frame = {
    setAttribute: vi.fn(),
    remove: vi.fn(),
    hidden: false,
    title: "",
    src: "",
  }
  const append = vi.fn(() => worker.port?.postMessage({ type: "started" }))
  vi.stubGlobal("window", { isSecureContext: true })
  vi.stubGlobal("navigator", { serviceWorker: { register } })
  vi.stubGlobal("document", {
    createElement: vi.fn(() => frame),
    body: { append },
  })
  return { register, frame, append }
}

afterEach(() => {
  releaseDestination(id)
  for (const port of ports.splice(0)) port.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("browser streaming destination lifecycle", () => {
  it("times out a stalled browser registration without starting a late download", async () => {
    vi.useFakeTimers()
    const worker = new SaveWorker()
    const env = environment(worker)
    let registered!: (value: Awaited<ReturnType<typeof env.register>>) => void
    env.register.mockImplementationOnce(
      () => new Promise((resolve) => (registered = resolve))
    )
    const destination = chooseDestination(id, "test.mkv", false)
    const rejected =
      expect(destination).rejects.toThrow("流式保存初始化超时，请重试。")
    await vi.advanceTimersByTimeAsync(15000)
    await rejected
    registered({ active: worker, installing: null, waiting: null })
    await Promise.resolve()
    expect(worker.postMessage).not.toHaveBeenCalled()
    expect(env.append).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels a stalled browser registration immediately and ignores its late result", async () => {
    vi.useFakeTimers()
    const worker = new SaveWorker()
    const env = environment(worker)
    let registered!: (value: Awaited<ReturnType<typeof env.register>>) => void
    env.register.mockImplementationOnce(
      () => new Promise((resolve) => (registered = resolve))
    )
    const destination = chooseDestination(id, "test.mkv", false)
    const rejected = expect(destination).rejects.toMatchObject({
      name: "AbortError",
    })
    releaseDestination(id)
    await rejected
    registered({ active: worker, installing: null, waiting: null })
    await Promise.resolve()
    expect(worker.postMessage).not.toHaveBeenCalled()
    expect(env.append).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("waits for the updated installing worker instead of sending an old active protocol", async () => {
    const updated = new SaveWorker(),
      old = new SaveWorker()
    updated.state = "installing"
    const env = environment(updated, old)
    const destination = chooseDestination(id, "test.mkv", false)
    await vi.waitFor(() => expect(env.register).toHaveBeenCalledOnce())
    expect(old.postMessage).not.toHaveBeenCalled()
    expect(updated.postMessage).not.toHaveBeenCalled()
    updated.state = "activated"
    updated.dispatchEvent(new Event("statechange"))
    const result = await destination
    expect(result.type).toBe("download")
    expect(env.register).toHaveBeenCalledWith("/browser-save-sw.js?v=2", {
      scope: "/local-saves/",
      updateViaCache: "none",
    })
    expect(updated.postMessage).toHaveBeenCalledWith(
      { type: "register-save", id, filename: "test.mkv" },
      expect.any(Array)
    )
    expect(old.postMessage).not.toHaveBeenCalled()
    releaseDestination(id)
    expect(updated.postMessage).toHaveBeenLastCalledWith({
      type: "release-save",
      id,
    })
    expect(env.frame.remove).toHaveBeenCalledOnce()
  })

  it("keeps the transferred SW endpoint alive for the writer handshake in Safari", async () => {
    const worker = new SaveWorker()
    worker.emulateSafariTransferredClose = true
    const env = environment(worker)
    const prepared = chooseDestination(id, "test.mkv", false)
    const resolved = vi.fn()
    // Observe completion with a short polling deadline, so a regression that
    // closes the SW endpoint fails without waiting for its 30-second timeout.
    void prepared.then(resolved, () => {})
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledOnce())
    const destination = await prepared
    if (destination.type !== "download") throw new Error("Expected a download")
    const writer = structuredClone(
      { port: destination.port },
      { transfer: [destination.port] }
    ).port as MessagePort
    ports.push(writer)
    const events: string[] = []
    let saved: Uint8Array | undefined
    const bytes = new Uint8Array([1, 2, 3, 4])
    worker.port!.onmessage = (event) => {
      events.push(`sw:${event.data.type}`)
      if (event.data.type === "writer-ready")
        worker.port!.postMessage({ type: "pull" })
      else if (event.data.type === "chunk") {
        saved = new Uint8Array(event.data.bytes)
        worker.port!.postMessage({ type: "ack", sequence: event.data.sequence })
      }
    }
    writer.onmessage = (event) => {
      events.push(`writer:${event.data.type}`)
      if (event.data.type === "pull") {
        const copy = bytes.slice().buffer
        writer.postMessage({ type: "chunk", sequence: 1, bytes: copy }, [copy])
      }
    }
    writer.start()
    writer.postMessage({ type: "writer-ready" })
    await vi.waitFor(() =>
      expect(events).toEqual([
        "sw:writer-ready",
        "writer:pull",
        "sw:chunk",
        "writer:ack",
      ])
    )
    expect(saved).toEqual(bytes)
    expect(worker.donorClosed).not.toHaveBeenCalled()
    releaseDestination(id)
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-save",
      id,
    })
    expect(env.frame.remove).toHaveBeenCalledOnce()
  })

  it("rejects an old worker without a protocol version before starting a download", async () => {
    const worker = new SaveWorker()
    worker.protocol = undefined
    const env = environment(worker)
    await expect(chooseDestination(id, "test.mkv", false)).rejects.toThrow(
      "流式保存组件版本不一致，请刷新页面后重试。"
    )
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-save",
      id,
    })
    expect(document.createElement).not.toHaveBeenCalled()
    expect(env.append).not.toHaveBeenCalled()
  })

  it("cancels preparation immediately and explicitly releases a registered pending stream", async () => {
    const worker = new SaveWorker()
    worker.acknowledge = false
    const env = environment(worker)
    const destination = chooseDestination(id, "test.mkv", false)
    const rejected = expect(destination).rejects.toMatchObject({
      name: "AbortError",
    })
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
    releaseDestination(id)
    await rejected
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-save",
      id,
    })
    expect(env.append).not.toHaveBeenCalled()
  })

  it("releases an active download even after its port belongs to a failed media worker", async () => {
    const worker = new SaveWorker()
    const env = environment(worker)
    const destination = await chooseDestination(id, "test.mkv", false)
    if (destination.type !== "download") throw new Error("Expected a download")
    const transferred = structuredClone(
      { port: destination.port },
      { transfer: [destination.port] }
    ) as { port: MessagePort }
    ports.push(transferred.port)
    const cancelled = new Promise<void>((resolve) => {
      transferred.port.onmessage = (event) => {
        if (event.data?.type === "cancel") resolve()
      }
    })
    releaseDestination(id)
    await cancelled
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-save",
      id,
    })
    expect(env.frame.remove).toHaveBeenCalledOnce()
  })

  it("a registration clone error releases the destination and removes phase listeners", async () => {
    const worker = new SaveWorker()
    environment(worker)
    const remove = vi.spyOn(worker, "removeEventListener")
    let donor: MessagePort | undefined
    worker.postMessage.mockImplementationOnce((_message, transfer) => {
      donor = transfer![0] as MessagePort
      ports.push(donor)
      vi.spyOn(donor, "close")
      throw new DOMException("Synthetic clone failure", "DataCloneError")
    })
    await expect(
      chooseDestination(id, "test.mkv", false)
    ).rejects.toMatchObject({
      name: "DataCloneError",
    })
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-save",
      id,
    })
    expect(remove).toHaveBeenCalledWith("statechange", expect.any(Function))
    expect(donor?.close).toHaveBeenCalledOnce()
  })
})
