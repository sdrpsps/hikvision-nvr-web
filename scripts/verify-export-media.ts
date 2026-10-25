import { config } from "dotenv"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, open, rm } from "node:fs/promises"
import { join } from "node:path"
import { recordingsQuerySchema } from "../shared/contracts"
import { readNvrConfig } from "../server/config"
import { NvrService } from "../server/recordings"
import { openRecordingDownload } from "../server/download"
import { AppError } from "../server/errors"
import {
  FragmentedMp4Demuxer,
  MpegPsDemuxer,
  MatroskaMuxer,
  type EncodedPacket,
} from "../lib/media-export"

// Read-only LAN verification. Real media exists only in a private temporary
// directory, is never displayed or logged, and is deleted even after failure.
config({ quiet: true })
let root: string | undefined
const round = (value: number) => Math.round(value * 1000) / 1000

function inspect(path: string) {
  const probe = spawnSync(
    process.env.FFPROBE_PATH || "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 }
  )
  if (probe.status !== 0)
    throw new Error("保存文件的容器检查失败，设备媒体详情已隐藏。")
  const result = JSON.parse(probe.stdout) as {
    streams: {
      codec_type: string
      codec_name: string
      width?: number
      height?: number
      sample_rate?: string
      channels?: number
    }[]
    format: { duration?: string }
  }
  const decode = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 }
  )
  if (decode.status !== 0 || decode.stderr.trim())
    throw new Error("保存文件的本机音视频解码检查失败，媒体详情已隐藏。")
  const seek = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      "2",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 }
  )
  if (seek.status !== 0 || seek.stderr.trim())
    throw new Error("保存文件的本机定位解码检查失败，媒体详情已隐藏。")
  const video = result.streams.find((stream) => stream.codec_type === "video")
  const audio = result.streams.find((stream) => stream.codec_type === "audio")
  if (!video || !audio) throw new Error("保存文件缺少预期的视频或音频轨道。")
  return {
    videoCodec: video.codec_name,
    width: video.width,
    height: video.height,
    audioCodec: audio.codec_name,
    sampleRate: Number(audio.sample_rate),
    channels: audio.channels,
    containerDurationSeconds: Number(result.format.duration),
    decodedWithoutErrors: true,
    seekDecodedWithoutErrors: true,
  }
}

async function verify(
  mode: "history" | "live",
  query: { track: string; date: string },
  target: number
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const path = join(root!, `${mode}.mkv`)
  const file = await open(path, "wx", 0o600)
  let position = 0
  const muxer = new MatroskaMuxer({
    async write(data) {
      let at = 0
      while (at < data.length) {
        const written = await file.write(data, at, data.length - at, position)
        if (!written.bytesWritten) throw new Error("临时文件写入没有推进。")
        position += written.bytesWritten
        at += written.bytesWritten
      }
    },
    async seek(value) {
      position = value
    },
  })
  const started = Date.now()
  let sourceBytes = 0,
    origin: number | undefined,
    end = false
  let early: EncodedPacket[] = []
  try {
    let response: Response
    if (mode === "history") {
      const service = new NvrService(readNvrConfig())
      const recordings = await service.recordings(query.track, query.date)
      const segment = recordings.segments[0]
      if (!segment) throw new Error("指定日期没有录像。")
      const source = await service.resolveSegment(
        query.track,
        query.date,
        segment.id
      )
      response = await openRecordingDownload(
        source.playbackURI,
        service.config,
        controller.signal
      )
    } else {
      const base = process.env.TEST_BASE_URL || "http://localhost:3102"
      response = await fetch(`${base}/api/transfers/live`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: new URL(base).origin,
        },
        body: JSON.stringify({ track: query.track }),
        signal: controller.signal,
      })
    }
    if (!response.ok || !response.body)
      throw new Error("未收到可用的媒体传输。")
    reader = response.body.getReader()
    const ps = new MpegPsDemuxer()
    const video = new FragmentedMp4Demuxer()
    const audio = new FragmentedMp4Demuxer()
    let transport = new Uint8Array(0)
    const accept = async (packets: EncodedPacket[]) => {
      origin ??= packets.find((packet) => packet.kind === "video")?.pts
      if (origin === undefined) {
        early.push(...packets)
        if (
          early.reduce((sum, packet) => sum + packet.data.length, 0) >
          1024 * 1024
        )
          throw new Error("等待视频时音频数据超过缓冲上限。")
        return
      }
      if (early.length) {
        packets = [...early, ...packets]
        early = []
      }
      for (const packet of packets) {
        if (
          packet.kind === "video" &&
          packet.keyframe &&
          packet.pts - origin >= target &&
          muxer.stats.videoPackets
        ) {
          end = true
          return
        }
        await muxer.add(packet)
      }
    }
    while (!end) {
      const chunk = await reader.read()
      if (chunk.done) {
        if (mode === "history") await accept(ps.finish())
        break
      }
      sourceBytes += chunk.value.length
      if (sourceBytes > 64 * 1024 * 1024)
        throw new Error("验证读取超过受控容量。")
      if (mode === "history") await accept(ps.push(chunk.value))
      else {
        const next = new Uint8Array(transport.length + chunk.value.length)
        next.set(transport)
        next.set(chunk.value, transport.length)
        transport = next
        while (transport.length >= 5 && !end) {
          const size = new DataView(
            transport.buffer,
            transport.byteOffset
          ).getUint32(1)
          if (size > 1024 * 1024) throw new Error("媒体传输块过大。")
          if (transport.length < size + 5) break
          const kind = transport[0],
            data = transport.slice(5, size + 5)
          transport = transport.slice(size + 5)
          if (kind === 1) await accept(video.push(data))
          else if (kind === 2) await accept(audio.push(data))
          else if (kind === 3) {
            const event = JSON.parse(new TextDecoder().decode(data))
            if (event.type === "error")
              throw new Error("设备实时媒体传输异常。")
          }
        }
      }
    }
    controller.abort()
    await reader.cancel().catch(() => {})
    await muxer.finish()
    await file.close()
    const inspected = inspect(path)
    console.log(
      JSON.stringify({
        mode,
        browserEngine: true,
        mediaProcessedIncrementally: true,
        targetDurationSeconds: target,
        sourceBytes,
        outputBytes: muxer.stats.bytesWritten,
        durationSeconds: round(muxer.stats.durationSeconds),
        videoPackets: muxer.stats.videoPackets,
        audioPackets: muxer.stats.audioPackets,
        elapsedMs: Date.now() - started,
        ...inspected,
      })
    )
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await reader?.cancel().catch(() => {})
    await file.close().catch(() => {})
    await rm(path, { force: true })
  }
}

try {
  const query = recordingsQuerySchema.parse({
    track: process.argv[2],
    date: process.argv[3],
  })
  const seconds = Number(process.argv[4] ?? 10)
  const mode = process.argv[5] ?? "both"
  if (
    !Number.isFinite(seconds) ||
    seconds < 3 ||
    seconds > 30 ||
    !["history", "live", "both"].includes(mode)
  )
    throw new Error("请提供 3–30 秒的验证时长和 history/live/both 模式。")
  root = await mkdtemp("/private/tmp/hikvision-export-real-")
  await chmod(root, 0o700)
  if (mode !== "live") await verify("history", query, seconds)
  if (mode !== "history") await verify("live", query, seconds)
} catch (error) {
  console.error(
    JSON.stringify({
      code:
        error instanceof AppError
          ? error.code
          : "EXPORT_MEDIA_VERIFICATION_FAILED",
      message:
        error instanceof AppError
          ? error.message
          : error instanceof Error
            ? error.message
            : "验证失败。",
    })
  )
  process.exitCode = 1
} finally {
  if (root) await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ realMediaTemporaryFilesRemoved: true }))
}
