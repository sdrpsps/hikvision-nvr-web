import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"
import type { NvrConfig } from "./config"
import { openRecordingDownload } from "./download"
import { AppError } from "./errors"
import { liveArguments } from "./live"

export const MAX_TRANSFER_SESSIONS = 4
export const MAX_TRANSFER_SOURCE_BYTES = 8 * 1024 ** 3
export const TRANSFER_IDLE_MS = 30_000
export const HISTORY_TRANSFER_TTL_MS = 30 * 60_000
export const LIVE_TRANSFER_TTL_MS = 2 * 60 * 60_000
export const MAX_TRANSFER_BUFFER_BYTES = 1024 ** 2
const MAX_TRANSPORT_CHUNK_BYTES = 1024 ** 2
const AUDIO_CLASSIFICATION_MS = 3000
const MAX_AUDIO_CLASSIFICATION_BYTES = 1024 ** 2

// Inspect only bounded startup lines, never retain or expose FFmpeg output.
// Audio can reach its pipe before stderr metadata, so classification gates it.
class LiveAudioGate {
  private state: "unknown" | "supported" | "unsupported" | "absent" = "unknown"
  private sourceAudioSeen = false
  private inputComplete = false
  private slaveFailed = false
  private tail = ""
  private queued: Buffer[] = []
  private queuedBytes = 0
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(
    private callbacks: {
      forward(chunk: Buffer): void
      unsupported(): void
      classified(): void
    }
  ) {}

  get classified() {
    return this.state !== "unknown"
  }

  videoArrived() {
    this.arm()
  }

  private arm() {
    if (this.state !== "unknown" || this.timer || this.disposed) return
    this.timer = setTimeout(
      () => this.classify("unsupported"),
      AUDIO_CLASSIFICATION_MS
    )
    this.timer.unref()
  }

  private classify(state: "supported" | "unsupported" | "absent") {
    if (this.disposed || this.state === "unsupported") return
    if (state === "supported" && this.slaveFailed) state = "unsupported"
    this.state = state
    clearTimeout(this.timer)
    this.timer = undefined
    if (state === "unsupported") this.callbacks.unsupported()
    if (state === "supported")
      for (const chunk of this.queued) this.callbacks.forward(chunk)
    this.queued.length = 0
    this.queuedBytes = 0
    this.callbacks.classified()
  }

  receive(chunk: Buffer) {
    if (this.disposed || this.state === "unsupported") return
    if (this.state === "supported") {
      this.callbacks.forward(chunk)
      return
    }
    if (
      this.state === "absent" ||
      this.queuedBytes + chunk.byteLength > MAX_AUDIO_CLASSIFICATION_BYTES
    ) {
      this.classify("unsupported")
      return
    }
    this.queued.push(chunk)
    this.queuedBytes += chunk.byteLength
    this.arm()
  }

  private line(line: string) {
    if (/\bSlave muxer #1 failed\b/.test(line)) {
      this.slaveFailed = true
      if (this.sourceAudioSeen) this.classify("unsupported")
    }
    if (!this.inputComplete && !this.sourceAudioSeen) {
      const match = /^\s*Stream #0:\d+[^\r\n]*:\s*Audio:\s*([a-z0-9_]+)?/i.exec(
        line
      )
      if (match) {
        this.sourceAudioSeen = true
        this.classify(
          ["pcm_alaw", "pcm_mulaw"].includes(match[1]?.toLowerCase() ?? "")
            ? "supported"
            : "unsupported"
        )
      }
    }
    if (/^\s*(?:Stream mapping:|Output #|Input #[1-9]\d*,)/.test(line)) {
      this.inputComplete = true
      if (!this.sourceAudioSeen && this.state === "unknown")
        this.classify(this.queuedBytes ? "unsupported" : "absent")
    }
  }

  diagnostics(chunk: Buffer) {
    if (this.disposed) return
    for (let at = 0; at < chunk.byteLength; at += 4096) {
      const lines = (
        this.tail + chunk.subarray(at, at + 4096).toString("utf8")
      ).split(/\r?\n/)
      this.tail = (lines.pop() ?? "").slice(-4096)
      for (const line of lines) this.line(line)
    }
  }

  diagnosticsEnd() {
    if (!this.disposed && this.tail) this.line(this.tail)
    this.tail = ""
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.tail = ""
    this.queued.length = 0
    this.queuedBytes = 0
  }
}

type Launcher = (args: string[]) => ChildProcess
type Download = typeof openRecordingDownload
type Options = {
  launch?: Launcher
  download?: Download
  maxSessions?: number
  maxBytes?: number
  idleMs?: number
  historyTtl?: number
  liveTtl?: number
  startupMs?: number
}
type Lease = {
  controller: AbortController
  touch: () => void
  release: () => void
}

function transferError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError("MEDIA_TRANSFER_FAILED", 502, "媒体传输中断，请重试。")
}

// This transport carries encoded media only. It never decodes, creates a media
// file, or keeps a recording-sized buffer on the server.
export class MediaTransfers {
  private active = new Set<AbortController>()
  constructor(private options: Options = {}) {}

  private acquire(parent: AbortSignal, ttl: number): Lease {
    if (this.active.size >= (this.options.maxSessions ?? MAX_TRANSFER_SESSIONS))
      throw new AppError(
        "MEDIA_BUSY",
        429,
        "录制与下载连接已达上限，请先停止其他任务。"
      )
    const controller = new AbortController()
    this.active.add(controller)
    let idle: ReturnType<typeof setTimeout> | undefined
    const absolute = setTimeout(
      () =>
        controller.abort(
          new AppError("MEDIA_TRANSFER_LIMIT", 504, "媒体传输已达到最长时限。")
        ),
      ttl
    )
    absolute.unref()
    const abort = () =>
      controller.abort(new AppError("MEDIA_CANCELLED", 503, "媒体传输已取消。"))
    const release = () => {
      clearTimeout(absolute)
      clearTimeout(idle)
      parent.removeEventListener("abort", abort)
      this.active.delete(controller)
    }
    controller.signal.addEventListener("abort", release, { once: true })
    parent.addEventListener("abort", abort, { once: true })
    if (parent.aborted) abort()
    const touch = () => {
      clearTimeout(idle)
      if (controller.signal.aborted) return
      idle = setTimeout(
        () =>
          controller.abort(
            new AppError(
              "MEDIA_TRANSFER_TIMEOUT",
              504,
              "媒体接收或文件写入长时间没有推进，请重试。"
            )
          ),
        this.options.idleMs ?? TRANSFER_IDLE_MS
      )
      idle.unref()
    }
    return { controller, touch, release }
  }

  async history(
    config: NvrConfig,
    resolve: () => Promise<{ playbackURI: string }>,
    parent: AbortSignal
  ): Promise<Response> {
    const lease = this.acquire(
      parent,
      this.options.historyTtl ?? HISTORY_TRANSFER_TTL_MS
    )
    const signal = lease.controller.signal
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const source = await resolve()
      if (signal.aborted) throw transferError(signal.reason)
      lease.touch()
      const response = await (this.options.download ?? openRecordingDownload)(
        source.playbackURI,
        config,
        signal
      )
      if (!response.body)
        throw new AppError(
          "NVR_DOWNLOAD_FAILED",
          502,
          "设备未返回可用的录像数据。"
        )
      if (signal.aborted) {
        await response.body.cancel()
        throw transferError(signal.reason)
      }
      const lengthHeader = response.headers.get("content-length")
      const expected =
        lengthHeader && /^\d+$/.test(lengthHeader)
          ? Number(lengthHeader)
          : undefined
      const limit = this.options.maxBytes ?? MAX_TRANSFER_SOURCE_BYTES
      if (
        expected !== undefined &&
        (!Number.isSafeInteger(expected) || expected > limit)
      ) {
        await response.body.cancel()
        throw new AppError(
          "MEDIA_SOURCE_LIMIT",
          502,
          "录像文件超过本次传输容量限制。"
        )
      }
      reader = response.body.getReader()
      const upstream = reader
      let finished = false,
        bytes = 0
      let streamController: ReadableStreamDefaultController<Uint8Array>
      const finish = (error?: AppError, cancelled = false) => {
        if (finished) return
        finished = true
        signal.removeEventListener("abort", aborted)
        lease.release()
        if (!signal.aborted) lease.controller.abort()
        void upstream.cancel().catch(() => {})
        if (!cancelled) {
          if (error) streamController.error(error)
          else streamController.close()
        }
      }
      const aborted = () => finish(transferError(signal.reason))
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller
            signal.addEventListener("abort", aborted, { once: true })
            if (signal.aborted) aborted()
          },
          async pull(controller) {
            if (finished) return
            lease.touch()
            try {
              const chunk = await upstream.read()
              if (finished) return
              if (chunk.done) {
                if (!bytes || (expected !== undefined && bytes !== expected))
                  finish(
                    new AppError(
                      "NVR_DOWNLOAD_INTERRUPTED",
                      502,
                      "录像读取不完整，请重试。"
                    )
                  )
                else finish()
                return
              }
              if (chunk.value.byteLength > MAX_TRANSPORT_CHUNK_BYTES) {
                finish(
                  new AppError(
                    "MEDIA_TRANSFER_INVALID",
                    502,
                    "录像媒体块超过传输限制。"
                  )
                )
                return
              }
              bytes += chunk.value.byteLength
              if (bytes > limit) {
                finish(
                  new AppError(
                    "MEDIA_SOURCE_LIMIT",
                    502,
                    "录像读取超过本次传输容量限制。"
                  )
                )
                return
              }
              lease.touch()
              controller.enqueue(chunk.value)
            } catch (error) {
              finish(transferError(signal.aborted ? signal.reason : error))
            }
          },
          cancel() {
            finish(undefined, true)
          },
        },
        { highWaterMark: 0 }
      )
      return new Response(stream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Accel-Buffering": "no",
          "X-Media-Format": "mpeg-ps",
          ...(expected === undefined
            ? {}
            : { "X-Media-Length": String(expected) }),
        },
      })
    } catch (error) {
      lease.release()
      if (!signal.aborted) lease.controller.abort()
      await reader?.cancel().catch(() => {})
      throw transferError(error)
    }
  }

  async live(
    config: NvrConfig,
    resolve: () => Promise<string>,
    parent: AbortSignal
  ): Promise<Response> {
    const lease = this.acquire(
      parent,
      this.options.liveTtl ?? LIVE_TRANSFER_TTL_MS
    )
    const signal = lease.controller.signal
    let child: ChildProcess | undefined
    let streamOwned = false
    const options = this.options
    try {
      const track = await resolve()
      if (signal.aborted) throw transferError(signal.reason)
      const launch =
        this.options.launch ??
        ((args: string[]) =>
          spawn(
            /* turbopackIgnore: true */ process.env.FFMPEG_PATH || "ffmpeg",
            args,
            {
              stdio: ["ignore", "pipe", "pipe", "pipe"],
              shell: false,
            }
          ))
      child = launch(
        liveArguments(config, track, {
          videoFragmentDurationUs: 500_000,
          reportAudioStatus: true,
        })
      )
      const childProcess = child
      const video = childProcess.stdout
      const audio = childProcess.stdio[3] as Readable | null
      if (!video || !audio)
        throw new AppError(
          "MEDIA_TOOL_UNAVAILABLE",
          503,
          "无法打开实时媒体传输。"
        )
      let ended = false,
        bytes = 0,
        videoReceived = false,
        readyResolved = false
      let resolveReady!: () => void, rejectReady!: (error: AppError) => void
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      void ready.catch(() => {})
      let streamController: ReadableStreamDefaultController<Uint8Array>
      const pause = () => {
        video.pause()
        audio.pause()
      }
      const resume = () => {
        if (!ended) {
          video.resume()
          audio.resume()
        }
      }
      const frame = (kind: number, payload: Uint8Array) => {
        const data = new Uint8Array(5 + payload.byteLength)
        data[0] = kind
        new DataView(data.buffer).setUint32(1, payload.byteLength)
        data.set(payload, 5)
        return data
      }
      const status = (message: object) =>
        frame(3, new TextEncoder().encode(JSON.stringify(message)))
      const enqueue = (kind: number, chunk: Uint8Array) => {
        if (ended) return
        streamController.enqueue(frame(kind, chunk))
        if ((streamController.desiredSize ?? 0) <= 0) pause()
      }
      const maybeReady = () => {
        if (!ended && !readyResolved && videoReceived && audioGate.classified) {
          readyResolved = true
          clearTimeout(startup)
          resolveReady()
        }
      }
      const audioGate = new LiveAudioGate({
        forward: (chunk) => enqueue(2, chunk),
        unsupported: () => {
          if (!ended)
            streamController.enqueue(
              status({ type: "audio", status: "unsupported" })
            )
        },
        classified: maybeReady,
      })
      const finish = (error?: AppError, cancelled = false) => {
        if (ended) return
        ended = true
        clearTimeout(startup)
        audioGate.dispose()
        signal.removeEventListener("abort", aborted)
        pause()
        lease.release()
        if (!signal.aborted) lease.controller.abort()
        childProcess.kill("SIGKILL")
        if (!readyResolved)
          rejectReady(
            error ??
              new AppError("MEDIA_CANCELLED", 503, "实时录制连接已取消。")
          )
        if (!cancelled) {
          const timeout = error?.code === "MEDIA_TRANSFER_LIMIT"
          if (timeout)
            streamController.enqueue(status({ type: "end", reason: "timeout" }))
          else if (error)
            streamController.enqueue(
              status({
                type: "error",
                code: error.code,
                message: error.message,
              })
            )
          streamController.close()
        }
      }
      const aborted = () => finish(transferError(signal.reason))
      const startup = setTimeout(
        () =>
          finish(
            new AppError(
              "LIVE_TIMEOUT",
              504,
              "等待实时录制媒体超时，请检查设备连接或通道权限。"
            )
          ),
        this.options.startupMs ?? 20_000
      )
      startup.unref()
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller
            signal.addEventListener("abort", aborted, { once: true })
            streamOwned = true
            childProcess.stderr?.on("data", (chunk: Buffer) =>
              audioGate.diagnostics(chunk)
            )
            childProcess.stderr?.on("end", () => audioGate.diagnosticsEnd())
            const receive = (kind: number, chunk: Buffer) => {
              if (ended) return
              if (chunk.byteLength > MAX_TRANSPORT_CHUNK_BYTES) {
                finish(
                  new AppError(
                    "MEDIA_TRANSFER_INVALID",
                    502,
                    "实时媒体块超过传输限制。"
                  )
                )
                return
              }
              bytes += chunk.byteLength
              if (bytes > (options.maxBytes ?? MAX_TRANSFER_SOURCE_BYTES)) {
                finish(
                  new AppError(
                    "MEDIA_SOURCE_LIMIT",
                    502,
                    "实时录制达到本次传输容量限制。"
                  )
                )
                return
              }
              lease.touch()
              if (kind === 2) audioGate.receive(chunk)
              else enqueue(kind, chunk)
              if (kind === 1 && !videoReceived) {
                videoReceived = true
                audioGate.videoArrived()
                maybeReady()
              }
              if ((controller.desiredSize ?? 0) <= 0) pause()
            }
            video.on("data", (chunk: Buffer) => receive(1, chunk))
            audio.on("data", (chunk: Buffer) => receive(2, chunk))
            video.on("error", () =>
              finish(
                new AppError("LIVE_INTERRUPTED", 502, "实时媒体读取中断。")
              )
            )
            audio.on("error", () =>
              finish(
                new AppError("LIVE_INTERRUPTED", 502, "实时音频读取中断。")
              )
            )
            childProcess.once("error", () =>
              finish(
                new AppError(
                  "MEDIA_TOOL_UNAVAILABLE",
                  503,
                  "无法启动 FFmpeg 实时媒体工具。"
                )
              )
            )
            childProcess.once("close", () =>
              finish(
                new AppError(
                  "LIVE_INTERRUPTED",
                  502,
                  "实时媒体连接中断，请重新开始录制。"
                )
              )
            )
            if (signal.aborted) aborted()
          },
          pull() {
            lease.touch()
            resume()
          },
          cancel() {
            finish(undefined, true)
          },
        },
        {
          highWaterMark: MAX_TRANSFER_BUFFER_BYTES,
          size: (chunk) => chunk.byteLength,
        }
      )
      await ready
      return new Response(stream, {
        headers: {
          "Content-Type": "application/vnd.nvr.media-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Accel-Buffering": "no",
          "X-Media-Format": "framed-fmp4",
        },
      })
    } catch (error) {
      lease.release()
      if (!signal.aborted) lease.controller.abort()
      // If setup fails before stream ownership, no child can be left behind.
      if (child && !streamOwned) child.kill("SIGKILL")
      throw transferError(error)
    }
  }

  dispose() {
    for (const controller of this.active)
      controller.abort(new AppError("MEDIA_CANCELLED", 503, "媒体传输已停止。"))
    this.active.clear()
  }
}
