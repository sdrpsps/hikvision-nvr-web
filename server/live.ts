import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { NvrConfig } from "./config"
import { AppError } from "./errors"
import { splitFragmentedMp4 } from "./mp4"
import { copiedAudio } from "./live-audio"

export const LIVE_TTL_MS = 10 * 60_000
export const LIVE_IDLE_MS = 30_000
export const MAX_LIVE_SESSIONS = 16
export const MAX_LIVE_BYTES = 32 * 1024 * 1024
const MAX_BOX_BYTES = 8 * 1024 * 1024
type Segment = { sequence: number; data: Buffer; duration: number }
type Session = {
  child?: ChildProcess
  timer: NodeJS.Timeout
  expiresAt: number
  touchedAt: number
  init: Buffer
  segments: Segment[]
  codec?: "h264" | "hevc"
  videoStartSeconds?: number
  audioStatus: "pending" | "available" | "unsupported"
  audio: (ReturnType<typeof copiedAudio> & { sequence: number })[]
  cancel: () => void
}
export function liveArguments(config: NvrConfig, track: string) {
  const uri = new URL(
    `rtsp://${config.NVR_HOST}:${config.NVR_RTSP_PORT}/Streaming/Channels/${track}`
  )
  uri.username = config.NVR_USERNAME
  uri.password = config.NVR_PASSWORD
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-rtsp_transport",
    "tcp",
    "-timeout",
    "10000000",
    "-i",
    uri.href,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-avoid_negative_ts",
    "make_zero",
    "-f",
    "tee",
    "[f=mp4:movflags=+frag_keyframe+empty_moov+default_base_moof:select=v]pipe:1|[f=mov:movflags=+frag_keyframe+empty_moov+default_base_moof:frag_duration=500000:select=a:onfail=ignore]pipe:3",
  ]
}
type Launcher = (args: string[]) => ChildProcess
const launch: Launcher = (args) =>
  spawn(/* turbopackIgnore: true */ process.env.FFMPEG_PATH || "ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    shell: false,
  })

// Bounded rolling fMP4 in memory. No private video files or raw FFmpeg logs.
export class LiveSessions {
  private sessions = new Map<string, Session>()
  constructor(
    private start: Launcher = launch,
    private ttl = LIVE_TTL_MS
  ) {}
  async create(
    config: NvrConfig,
    resolve: () => Promise<string>,
    signal: AbortSignal
  ) {
    if (this.sessions.size >= MAX_LIVE_SESSIONS)
      throw new AppError(
        "MEDIA_BUSY",
        429,
        "实时预览已达 16 路上限，请先停止其他窗口。"
      )
    const id = randomUUID(),
      expiresAt = Date.now() + this.ttl
    let rejectReady!: (error: AppError) => void
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Attach immediately: channel resolution may fail before awaiting readiness.
    void ready.catch(() => {})
    const fail = (
      code = "LIVE_INTERRUPTED",
      message = "实时画面连接中断，请重新播放。"
    ) => {
      rejectReady(new AppError(code, 502, message))
      this.delete(id)
    }
    const timer = setInterval(() => {
      const session = this.sessions.get(id)
      if (
        session &&
        (Date.now() >= expiresAt ||
          Date.now() - session.touchedAt > LIVE_IDLE_MS)
      )
        fail()
    }, 1000)
    timer.unref()
    const session: Session = {
      timer,
      expiresAt,
      touchedAt: Date.now(),
      init: Buffer.alloc(0),
      segments: [],
      audioStatus: "pending",
      audio: [],
      cancel: () =>
        rejectReady(new AppError("MEDIA_CANCELLED", 503, "实时预览已停止。")),
    }
    this.sessions.set(id, session)
    const abort = () => this.delete(id)
    signal.addEventListener("abort", abort, { once: true })
    const startup = setTimeout(
      () =>
        fail("LIVE_TIMEOUT", "等待实时画面超时，请检查设备连接或通道权限。"),
      20_000
    )
    startup.unref()
    let pending = Buffer.alloc(0),
      fragment = Buffer.alloc(0),
      sequence = 0
    try {
      if (signal.aborted) abort()
      const track = await resolve()
      if (!this.sessions.has(id))
        throw new AppError("MEDIA_CANCELLED", 503, "实时预览已停止。")
      const child = this.start(liveArguments(config, track))
      session.child = child
      child.stderr?.resume()
      child.on("error", () =>
        fail("MEDIA_TOOL_UNAVAILABLE", "无法启动 FFmpeg 实时换封装工具。")
      )
      child.on("close", () => fail())
      let audioPending = Buffer.alloc(0),
        audioInit = Buffer.alloc(0),
        audioFragment = Buffer.alloc(0),
        audioSequence = 0
      const audioPipe = child.stdio?.[3]
      if (audioPipe && "on" in audioPipe)
        audioPipe.on("data", (chunk: Buffer) => {
          if (!this.sessions.has(id) || session.audioStatus === "unsupported")
            return
          try {
            if (audioPending.length + chunk.length > 256 * 1024)
              throw new Error()
            audioPending = Buffer.concat([audioPending, chunk])
            while (audioPending.length >= 8) {
              const size = audioPending.readUInt32BE(0)
              if (size < 8 || size > 256 * 1024) throw new Error()
              if (audioPending.length < size) break
              const box = audioPending.subarray(0, size),
                type = box.toString("ascii", 4, 8)
              audioPending = audioPending.subarray(size)
              if (type === "ftyp" || type === "moov") {
                if (audioInit.length + box.length > 64 * 1024) throw new Error()
                audioInit = Buffer.concat([audioInit, box])
              } else if (type === "moof") audioFragment = box
              else if (type === "mdat") {
                const audio = copiedAudio(
                  audioInit,
                  Buffer.concat([audioFragment, box])
                )
                session.audio.push({ ...audio, sequence: audioSequence++ })
                session.audioStatus = "available"
                audioFragment = Buffer.alloc(0)
                while (
                  session.audio.length > 80 ||
                  session.audio.reduce(
                    (sum, item) => sum + item.data.length,
                    0
                  ) >
                    512 * 1024
                )
                  session.audio.shift()
              }
            }
          } catch {
            session.audioStatus = "unsupported"
            session.audio = []
            audioPending = audioInit = audioFragment = Buffer.alloc(0)
          }
        })
      child.stdout?.on("data", (chunk: Buffer) => {
        if (!this.sessions.has(id)) return
        try {
          if (pending.length + chunk.length > MAX_BOX_BYTES) throw new Error()
          pending = Buffer.concat([pending, chunk])
          while (pending.length >= 8) {
            const size = pending.readUInt32BE(0)
            if (size < 8 || size > MAX_BOX_BYTES) throw new Error()
            if (pending.length < size) break
            const box = pending.subarray(0, size),
              type = box.toString("ascii", 4, 8)
            pending = pending.subarray(size)
            if (type === "ftyp" || type === "moov") {
              if (
                session.segments.length ||
                session.init.length + box.length > 256 * 1024
              )
                throw new Error()
              session.init = Buffer.concat([session.init, box])
            } else if (type === "moof") fragment = box
            else if (type === "mdat") {
              if (
                !fragment.length ||
                fragment.length + box.length > MAX_BOX_BYTES
              )
                throw new Error()
              const data = Buffer.concat([fragment, box])
              const media = splitFragmentedMp4(
                Buffer.concat([session.init, data])
              )
              session.codec = media.codec
              session.videoStartSeconds ??= media.startSeconds
              session.segments.push({
                sequence: sequence++,
                data,
                duration: media.durationSeconds,
              })
              fragment = Buffer.alloc(0)
              while (
                session.segments.length > 6 ||
                session.segments.reduce(
                  (sum, item) => sum + item.data.length,
                  0
                ) > MAX_LIVE_BYTES
              )
                session.segments.shift()
              if (session.segments.length) resolveReady()
            }
          }
        } catch {
          fail(
            "LIVE_INVALID_MEDIA",
            "实时视频无法直接封装为 H.264 / H.265 播放流，请检查设备编码。"
          )
        }
      })
      await ready
      if (!this.sessions.has(id))
        throw new AppError("MEDIA_CANCELLED", 503, "实时预览已停止。")
      return {
        id,
        playlistUrl: `/api/streams/${id}/index.m3u8`,
        expiresAt: new Date(expiresAt).toISOString(),
        mode: "stream-copy" as const,
        codec: session.codec!,
      }
    } catch (error) {
      this.delete(id)
      throw error
    } finally {
      clearTimeout(startup)
      signal.removeEventListener("abort", abort)
    }
  }
  has(id: string) {
    return this.sessions.has(id)
  }
  private get(id: string) {
    const session = this.sessions.get(id)
    if (
      !session ||
      Date.now() >= session.expiresAt ||
      Date.now() - session.touchedAt > LIVE_IDLE_MS
    ) {
      this.delete(id)
      throw new AppError("MEDIA_NOT_FOUND", 404, "实时会话已结束，请重新播放。")
    }
    session.touchedAt = Date.now()
    return session
  }
  playlist(id: string) {
    const { segments } = this.get(id)
    return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${Math.max(1, ...segments.map((s) => Math.ceil(s.duration)))}\n#EXT-X-MEDIA-SEQUENCE:${segments[0]?.sequence ?? 0}\n#EXT-X-MAP:URI="init.mp4"\n${segments.map((s) => `#EXTINF:${s.duration.toFixed(6)},\n${s.sequence}.m4s\n`).join("")}`
  }
  audio(id: string, after: number) {
    const session = this.get(id)
    return {
      status: session.audioStatus,
      videoStartSeconds: session.videoStartSeconds ?? 0,
      chunks: session.audio
        .filter((item) => item.sequence > after)
        .map((item) => ({ ...item, data: item.data.toString("base64") })),
    }
  }
  asset(id: string, asset: string) {
    const session = this.get(id)
    if (asset === "init.mp4") return session.init
    const match = /^(0|[1-9]\d{0,9})\.m4s$/.exec(asset)
    const segment =
      match && session.segments.find((s) => s.sequence === Number(match[1]))
    if (!segment) throw new AppError("MEDIA_NOT_FOUND", 404, "实时分片已过期。")
    return segment.data
  }
  delete(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    clearInterval(session.timer)
    session.cancel()
    session.child?.kill("SIGKILL")
    session.init = Buffer.alloc(0)
    session.segments = []
    session.audio = []
  }
  dispose() {
    for (const id of this.sessions.keys()) this.delete(id)
  }
}
