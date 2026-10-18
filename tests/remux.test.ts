import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { readFileSync } from "node:fs"
import { describe, expect, it, vi, afterEach } from "vitest"
import { spawn } from "node:child_process"
import { openRecordingDownload } from "../server/download"
import { remuxRecording } from "../server/remux"
import { readNvrConfig } from "../server/config"
vi.mock("node:child_process", () => ({ spawn: vi.fn() }))
vi.mock("../server/download", () => ({ openRecordingDownload: vi.fn() }))
const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test",
  NVR_PASSWORD: "test",
})
const fixture = readFileSync(
  new URL("../fixtures/synthetic-preview.mp4", import.meta.url)
)
function processStub(finish?: (child: ReturnType<typeof processStub>) => void) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
    final(callback) {
      callback()
      queueMicrotask(() => finish?.(child))
    },
  })
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => {
    queueMicrotask(() => {
      child.stdin.destroy()
      child.emit("close", null)
    })
    return true
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  return child
}
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
describe("remux resource cleanup", () => {
  it("streams input and returns a structurally valid preview without disk files", async () => {
    vi.mocked(openRecordingDownload).mockResolvedValue(
      new Response("synthetic input")
    )
    const child = processStub((child) => {
      child.stdout.write(fixture)
      child.emit("close", 0)
    })
    const result = await remuxRecording(
      "rtsp://nvr.test/synthetic",
      config,
      new AbortController().signal
    )
    expect(result.durationSeconds).toBe(3)
    expect(child.stdin.writableFinished).toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["-c:v", "copy"]),
      expect.objectContaining({ shell: false })
    )
  })
  it("kills FFmpeg and cancels the download when the caller aborts", async () => {
    let cancelled = false
    vi.mocked(openRecordingDownload).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]))
          },
          cancel() {
            cancelled = true
          },
        })
      )
    )
    const child = processStub(),
      controller = new AbortController()
    const pending = remuxRecording(
      "rtsp://nvr.test/synthetic",
      config,
      controller.signal
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(cancelled).toBe(true)
  })
  it("enforces preparation timeout and source/output byte limits", async () => {
    vi.useFakeTimers()
    vi.mocked(openRecordingDownload).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]))
          },
        })
      )
    )
    const child = processStub()
    const pending = remuxRecording(
      "rtsp://nvr.test/synthetic",
      config,
      new AbortController().signal
    )
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MEDIA_CANCELLED",
    })
    await vi.advanceTimersByTimeAsync(30001)
    await rejected
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    vi.useRealTimers()
    vi.mocked(openRecordingDownload).mockResolvedValue(
      new Response(new Uint8Array(32 * 1024 * 1024 + 1))
    )
    processStub()
    await expect(
      remuxRecording(
        "rtsp://nvr.test/synthetic",
        config,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "MEDIA_SOURCE_LIMIT" })
    vi.mocked(openRecordingDownload).mockResolvedValue(
      new Response("synthetic input")
    )
    processStub((child) =>
      child.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1))
    )
    await expect(
      remuxRecording(
        "rtsp://nvr.test/synthetic",
        config,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "MEDIA_OUTPUT_LIMIT" })
  })
  it("handles missing binary and malformed/empty process output safely", async () => {
    vi.mocked(openRecordingDownload).mockResolvedValue(
      new Response("synthetic")
    )
    processStub((child) => {
      child.emit("error", new Error("private executable path"))
      child.emit("close", null)
    })
    await expect(
      remuxRecording(
        "rtsp://nvr.test/synthetic",
        config,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "MEDIA_TOOL_UNAVAILABLE" })
    vi.mocked(openRecordingDownload).mockResolvedValue(
      new Response("synthetic")
    )
    processStub((child) => child.emit("close", 1))
    await expect(
      remuxRecording(
        "rtsp://nvr.test/synthetic",
        config,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "MEDIA_REMUX_FAILED" })
  })
})
