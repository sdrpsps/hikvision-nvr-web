import { spawn } from "node:child_process"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { NvrConfig } from "./config"
import { openRecordingDownload } from "./download"
import { AppError } from "./errors"
import { splitFragmentedMp4 } from "./mp4"

export const PREVIEW_SECONDS = 30
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export function remuxArguments() {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts",
    "-f",
    "mpeg",
    "-i",
    "pipe:0",
    "-map",
    "0:v:0",
    "-c:v",
    "copy",
    "-an",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-t",
    String(PREVIEW_SECONDS),
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration",
    "2000000",
    "-f",
    "mp4",
    "pipe:1",
  ]
}
export type PreviewMedia = ReturnType<typeof splitFragmentedMp4>
export type Remuxer = (
  uri: string,
  config: NvrConfig,
  signal: AbortSignal
) => Promise<PreviewMedia>
export const remuxRecording: Remuxer = async (uri, config, parentSignal) => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  parentSignal.addEventListener("abort", abort, { once: true })
  if (parentSignal.aborted) controller.abort()
  const timer = setTimeout(abort, 30000)
  let reader: Readable | undefined
  try {
    const response = await openRecordingDownload(uri, config, controller.signal)
    if (controller.signal.aborted) {
      await response.body?.cancel()
      throw new AppError("MEDIA_CANCELLED", 503, "录像请求已取消。")
    }
    reader = Readable.fromWeb(
      response.body! as import("node:stream/web").ReadableStream
    )
    const child = spawn(
      /* turbopackIgnore: true */ process.env.FFMPEG_PATH || "ffmpeg",
      remuxArguments(),
      {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      }
    )
    const chunks: Buffer[] = []
    let bytes = 0,
      sourceBytes = 0,
      limitError: AppError | undefined,
      unavailable = false,
      inputFailed = false
    const stop = () => {
      child.kill("SIGKILL")
      reader?.destroy()
    }
    controller.signal.addEventListener("abort", stop, { once: true })
    if (controller.signal.aborted) stop()
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sourceBytes += chunk.length
        if (sourceBytes > MAX_SOURCE_BYTES) {
          limitError = new AppError(
            "MEDIA_SOURCE_LIMIT",
            502,
            "录像读取超过本次预览容量限制。请选择较短的录像文件。"
          )
          controller.abort()
          callback(limitError)
        } else callback(null, chunk)
      },
    })
    // Discard raw stderr: it can contain device-derived metadata. No video file is written.
    child.stderr.resume()
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) {
        limitError = new AppError(
          "MEDIA_OUTPUT_LIMIT",
          502,
          "预览超过容量限制。"
        )
        controller.abort()
      } else chunks.push(chunk)
    })
    child.on("error", () => {
      unavailable = true
    })
    const input = pipeline(reader, limiter, child.stdin).catch(() => {
      inputFailed = true
    })
    const code = await new Promise<number | null>((resolve) =>
      child.once("close", resolve)
    )
    reader.destroy()
    await input
    controller.signal.removeEventListener("abort", stop)
    if (limitError) throw limitError
    if (unavailable)
      throw new AppError(
        "MEDIA_TOOL_UNAVAILABLE",
        503,
        "服务端缺少 FFmpeg 换封装工具。"
      )
    if (controller.signal.aborted)
      throw new AppError("MEDIA_CANCELLED", 503, "录像预览已取消或准备超时。")
    if (code !== 0 || !bytes)
      throw new AppError(
        "MEDIA_REMUX_FAILED",
        502,
        inputFailed
          ? "读取录像中断，请重试。"
          : "录像无法直接换封装，当前预览不执行转码。"
      )
    return splitFragmentedMp4(Buffer.concat(chunks, bytes))
  } finally {
    controller.abort()
    clearTimeout(timer)
    reader?.destroy()
    parentSignal.removeEventListener("abort", abort)
  }
}
