import type { NvrConfig } from "./config"
import { openRecordingDownload } from "./download"
import { AppError } from "./errors"
import { HikPsClock } from "./hik-ps-clock"
import { IsapiClient } from "./isapi"
import { PlaybackCapabilities } from "./playback-capabilities"
import { replayRecording } from "./playback-source"
import { validatePlaybackUri } from "./recordings"
import { openShttpReplay } from "./shttp-replay"
import type { RawSegment } from "./xml"

export type PlaybackInputMetadata = {
  source: "shttp"
  mediaStartAt: string
  firstVideoHash: string
  fileDurationSeconds: number
  startOffsetSeconds: number
  estimatedDurationSeconds: number
}
export type PlaybackInputContext = {
  recording: RawSegment
  requestedAt?: string
  onReady: (metadata: PlaybackInputMetadata) => void
}
type PlaybackInput = {
  stream: ReadableStream<Uint8Array>
  durationSeconds?: number
  finished?: Promise<{ complete: boolean }>
  close: () => void
}
const capabilities = new WeakMap<NvrConfig, PlaybackCapabilities>()
// The device ends a requested window before its last GOP. Read a bounded guard
// and let FFmpeg's copy-only duration limit stop at the trusted file boundary.
const END_GUARD_MS = 10_000
const MAX_CLOCK_PREFIX_BYTES = 1024 * 1024

export async function openPlaybackInput(
  uri: string,
  config: NvrConfig,
  signal: AbortSignal,
  context?: PlaybackInputContext
): Promise<PlaybackInput> {
  signal.throwIfAborted()
  let nativeTrack: Awaited<ReturnType<PlaybackCapabilities["forTrack"]>>
  if (context) {
    let cached = capabilities.get(config)
    if (!cached) {
      cached = new PlaybackCapabilities(new IsapiClient(config))
      capabilities.set(config, cached)
    }
    nativeTrack = await cached.forTrack(context.recording.trackId, signal)
  }
  if (!context || !nativeTrack) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    try {
      const response = await openRecordingDownload(
        uri,
        config,
        controller.signal
      )
      return {
        stream: response.body!,
        close() {
          signal.removeEventListener("abort", abort)
          controller.abort()
          void response.body?.cancel().catch(() => {})
        },
      }
    } catch (error) {
      signal.removeEventListener("abort", abort)
      controller.abort()
      throw error
    }
  }
  validatePlaybackUri(uri, config)
  const plan = replayRecording(context.recording, context.requestedAt)
  const source = await openShttpReplay(
    config,
    {
      ...nativeTrack,
      startAt: plan.replay.startAt,
      endAt: new Date(
        Date.parse(plan.replay.endAt) + END_GUARD_MS
      ).toISOString(),
    },
    signal
  )
  const reader = source.stream.getReader()
  const prefix: Uint8Array[] = []
  let prefixBytes = 0
  const close = () => {
    source.close()
    void reader.cancel().catch(() => {})
  }
  try {
    const clock = new HikPsClock(config.NVR_TIME_ZONE, {
      requireRandomAccess: true,
    })
    while (!clock.startAt) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      prefixBytes += next.value.byteLength
      if (prefixBytes > MAX_CLOCK_PREFIX_BYTES) break
      prefix.push(next.value)
      clock.push(next.value)
      if (clock.error) break
    }
    if (!clock.startAt || !clock.firstVideoHash)
      throw new AppError(
        "MEDIA_CLOCK_UNCONFIRMED",
        502,
        "设备未提供可确认的录像画面时间，无法安全定位。"
      )
    const actual = Date.parse(clock.startAt)
    const target = Date.parse(plan.replay.requestedAt)
    const fileStart = Date.parse(plan.fileRange!.startAt)
    const end = Date.parse(plan.replay.endAt)
    if (
      actual < fileStart - 1000 ||
      actual > target + 1000 ||
      target - actual > 30_000 ||
      actual >= end
    )
      throw new AppError(
        "MEDIA_CLOCK_MISMATCH",
        502,
        "设备返回的画面时间与所选录像不符，已停止回放。"
      )
    const durationSeconds = (end - actual) / 1000
    context.onReady({
      source: "shttp",
      mediaStartAt: clock.startAt,
      firstVideoHash: clock.firstVideoHash,
      fileDurationSeconds: plan.fileDurationSeconds,
      startOffsetSeconds: Math.max(0, (target - actual) / 1000),
      estimatedDurationSeconds: durationSeconds,
    })
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const buffered = prefix.shift()
          if (buffered) {
            controller.enqueue(buffered)
            return
          }
          try {
            const next = await reader.read()
            if (next.done) controller.close()
            else controller.enqueue(next.value)
          } catch (error) {
            controller.error(error)
            close()
          }
        },
        cancel() {
          close()
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 })
    )
    return { stream, durationSeconds, finished: source.finished, close }
  } catch (error) {
    close()
    throw error
  }
}
