import { spawn } from "node:child_process"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { AppError } from "./errors"
import { splitFragmentedMp4 } from "./mp4"
import { remuxArguments, type PreviewMedia } from "./remux"
import type { NvrConfig } from "./config"
import { copiedAudio, CopiedAudioParser } from "./live-audio"
import { openPlaybackInput, type PlaybackInputContext } from "./playback-input"

export const MAX_PLAYBACK_SOURCE_BYTES = 4 * 1024 ** 3
export const MAX_FRAGMENT_BYTES = 16 * 1024 ** 2
export const PLAYBACK_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
export const PLAYBACK_COVERAGE_TOLERANCE_SECONDS = 1
const DECODE_CONTINUITY_TOLERANCE_SECONDS = 0.05
const remuxFailed = () =>
  new AppError("MEDIA_REMUX_FAILED", 502, "录像读取中断，请重新播放。")

export function playbackRemuxArguments(durationSeconds?: number) {
  if (
    durationSeconds !== undefined &&
    (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
  )
    throw new AppError("MEDIA_INVALID_RANGE", 502, "录像播放范围无效。")
  const args = remuxArguments()
  // The historical diagnostic still has a 30-second limit; full playback does not.
  args.splice(args.indexOf("-t"), 2)
  args.splice(args.indexOf("-an"), 1)
  args.splice(args.indexOf("-map") + 2, 0, "-map", "0:a:0?", "-c:a", "copy")
  args.splice(args.indexOf("-movflags"))
  if (durationSeconds !== undefined) args.push("-t", String(durationSeconds))
  // Historical seeking may start with any listed video fragment. Keep each
  // fragment on a keyframe so the decoder never needs an earlier fragment.
  args.push(
    "-f",
    "tee",
    "[f=mp4:movflags=+frag_keyframe+empty_moov+default_base_moof:select=v]pipe:1|[f=mov:movflags=+frag_keyframe+empty_moov+default_base_moof:frag_duration=500000:select=a:onfail=ignore]pipe:3"
  )
  return args
}

export type RecordingFragments = (
  uri: string,
  config: NvrConfig,
  signal: AbortSignal,
  onAudio?: (
    chunk: ReturnType<typeof copiedAudio> | { status: "unsupported" }
  ) => Promise<void>,
  context?: PlaybackInputContext
) => AsyncIterable<PreviewMedia>

// Incremental structural parsing only. Each yielded fragment is still encoded video.
export const recordingFragments: RecordingFragments = async function* (
  uri,
  config,
  signal,
  onAudio,
  context
) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const timeout = setTimeout(abort, PLAYBACK_DOWNLOAD_TIMEOUT_MS)
  let reader: Readable | undefined
  let child: ReturnType<typeof spawn> | undefined
  let source: Awaited<ReturnType<typeof openPlaybackInput>> | undefined
  let inputTask: Promise<void> | undefined
  let audioTask: Promise<void> | undefined
  let exited: Promise<number | null> | undefined
  let localInputClose = false
  try {
    source = await openPlaybackInput(uri, config, controller.signal, context)
    const durationSeconds = source.durationSeconds
    const args = playbackRemuxArguments(durationSeconds)
    if (durationSeconds !== undefined) clearTimeout(timeout)
    if (controller.signal.aborted)
      throw new AppError("MEDIA_CANCELLED", 503, "录像读取已取消或超时。")
    reader = Readable.fromWeb(
      source.stream as import("node:stream/web").ReadableStream
    )
    child = spawn(
      /* turbopackIgnore: true */ process.env.FFMPEG_PATH || "ffmpeg",
      args,
      {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        shell: false,
      }
    )
    const childProcess = child
    const stop = () => {
      localInputClose = true
      childProcess.kill("SIGKILL")
      reader?.destroy()
      source?.close()
    }
    controller.signal.addEventListener("abort", stop, { once: true })
    if (controller.signal.aborted) stop()
    let unavailable = false
    exited = new Promise<number | null>((resolve) => {
      childProcess.once("error", () => {
        unavailable = true
      })
      childProcess.once("close", resolve)
    })
    childProcess.stderr!.resume()
    let audioError: unknown
    const audioPipe = childProcess.stdio[3] as Readable
    audioTask = (async () => {
      const audioParser = new CopiedAudioParser({ skipEmptyMedia: true })
      let supported = true,
        received = false
      for await (const raw of audioPipe) {
        if (!onAudio || !supported) continue
        try {
          for (const chunk of audioParser.push(raw as Buffer)) {
            await onAudio(chunk)
            received = true
          }
        } catch (error) {
          if (
            error instanceof AppError &&
            [
              "MEDIA_OUTPUT_LIMIT",
              "MEDIA_DISK_LIMIT",
              "MEDIA_CANCELLED",
            ].includes(error.code)
          )
            throw error
          supported = false
          audioParser.reset()
          await onAudio({ status: "unsupported" })
        }
      }
      if (onAudio && !received && supported)
        await onAudio({ status: "unsupported" })
    })().catch((error: unknown) => {
      if (
        controller.signal.aborted ||
        (localInputClose && !(error instanceof AppError))
      )
        return
      audioError = error
      controller.abort()
    })
    let sourceBytes = 0
    let limitError: AppError | undefined
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sourceBytes += chunk.length
        if (sourceBytes > MAX_PLAYBACK_SOURCE_BYTES) {
          limitError = new AppError(
            "MEDIA_SOURCE_LIMIT",
            502,
            "录像文件超过本次播放容量限制。"
          )
          controller.abort()
          callback(limitError)
        } else callback(null, chunk)
      },
    })
    let inputError: unknown,
      sourceError: unknown,
      sourceFinished: { complete: boolean } | undefined,
      completionError: unknown
    let sourceEnded = false,
      sinkClosed = false,
      sourceStoppedEarly = false
    const completion = source.finished
      ?.then((result) => {
        sourceFinished = result
        if (!result.complete && !localInputClose && !sinkClosed)
          sourceStoppedEarly = true
      })
      .catch((reason: unknown) => {
        completionError = reason
      })
    reader.once("end", () => {
      if (!localInputClose && !sinkClosed) sourceEnded = true
    })
    reader.on("error", (reason: unknown) => {
      if (!localInputClose && !sinkClosed) sourceError = reason
    })
    childProcess.stdin!.on("error", () => {
      sinkClosed = true
    })
    childProcess.stdin!.once("close", () => {
      sinkClosed = true
    })
    const expectedPipeError = (reason: unknown) =>
      !(reason instanceof AppError) &&
      ["EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(
        (reason as { code?: string } | undefined)?.code ?? ""
      )
    inputTask = pipeline(reader, limit, childProcess.stdin!).catch(
      (reason: unknown) => {
        inputError = reason
        if (
          durationSeconds === undefined ||
          sourceError ||
          !expectedPipeError(reason)
        )
          stop()
      }
    )
    let pending = Buffer.alloc(0),
      init = Buffer.alloc(0),
      fragment = Buffer.alloc(0)
    let outputError: unknown
    let decodeSeconds = 0,
      discontinuity = 0,
      decodeEnd: number | undefined
    try {
      for await (const raw of childProcess.stdout!) {
        const chunk = raw as Buffer
        if (pending.length + chunk.length > MAX_FRAGMENT_BYTES)
          throw new AppError(
            "MEDIA_FRAGMENT_LIMIT",
            502,
            "录像分片超过容量限制。"
          )
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 8) {
          const size = pending.readUInt32BE(0)
          if (size < 8 || size > MAX_FRAGMENT_BYTES)
            throw new AppError(
              "MEDIA_INVALID_CONTAINER",
              502,
              "录像封装不完整或不受支持。"
            )
          if (pending.length < size) break
          const box = pending.subarray(0, size),
            type = box.toString("ascii", 4, 8)
          pending = pending.subarray(size)
          if (type === "ftyp" || type === "moov") {
            if (init.length + box.length > 256 * 1024)
              throw new AppError(
                "MEDIA_INVALID_CONTAINER",
                502,
                "录像初始化信息异常。"
              )
            init = Buffer.concat([init, box])
          } else if (type === "moof") fragment = box
          else if (type === "mdat") {
            if (
              !fragment.length ||
              fragment.length + box.length > MAX_FRAGMENT_BYTES
            )
              throw new AppError(
                "MEDIA_INVALID_CONTAINER",
                502,
                "录像分片不完整。"
              )
            const media = splitFragmentedMp4(
              Buffer.concat([init, fragment, box])
            )
            if (durationSeconds !== undefined) {
              if (decodeEnd !== undefined)
                discontinuity += Math.abs(media.decodeStartSeconds - decodeEnd)
              decodeSeconds += media.decodeDurationSeconds
              decodeEnd = media.decodeStartSeconds + media.decodeDurationSeconds
            }
            yield media
            fragment = Buffer.alloc(0)
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        outputError = error
        stop()
      }
    }
    const code = await exited
    // A bounded, successful FFmpeg output can close stdin before the guarded
    // source finishes. Record that local boundary before cancelling the source.
    localInputClose = true
    reader.destroy()
    source.close()
    await inputTask
    await audioTask
    await completion
    controller.signal.removeEventListener("abort", stop)
    if (limitError) throw limitError
    if (unavailable)
      throw new AppError(
        "MEDIA_TOOL_UNAVAILABLE",
        503,
        "无法启动 FFmpeg 换封装工具。"
      )
    if (audioError)
      throw audioError instanceof AppError ? audioError : remuxFailed()
    if (controller.signal.aborted)
      throw new AppError("MEDIA_CANCELLED", 503, "录像读取已取消或超时。")
    if (sourceError instanceof AppError) throw sourceError
    if (inputError instanceof AppError) throw inputError
    if (outputError)
      throw outputError instanceof AppError ? outputError : remuxFailed()
    const covered =
      durationSeconds !== undefined &&
      decodeEnd !== undefined &&
      decodeSeconds > 0 &&
      Math.abs(decodeSeconds - durationSeconds) <=
        PLAYBACK_COVERAGE_TOLERANCE_SECONDS + 1e-6 &&
      discontinuity <= DECODE_CONTINUITY_TOLERANCE_SECONDS
    const expectedClose =
      covered &&
      !sourceError &&
      !sourceStoppedEarly &&
      (!inputError || expectedPipeError(inputError)) &&
      !(sourceEnded && sourceFinished?.complete === false)
    if (
      code !== 0 ||
      pending.length ||
      fragment.length ||
      completionError ||
      (durationSeconds !== undefined && !covered) ||
      (sourceError && !expectedClose) ||
      (inputError && !expectedClose) ||
      (sourceFinished?.complete === false && !expectedClose)
    )
      throw remuxFailed()
  } finally {
    localInputClose = true
    controller.abort()
    child?.kill("SIGKILL")
    reader?.destroy()
    source?.close()
    if (!reader) await source?.stream.cancel().catch(() => {})
    clearTimeout(timeout)
    signal.removeEventListener("abort", abort)
    await inputTask
    await audioTask
    await exited
  }
}
