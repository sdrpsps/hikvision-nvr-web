import { randomUUID } from "node:crypto"
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NvrConfig } from "./config"
import { AppError } from "./errors"
import { recordingFragments, type RecordingFragments } from "./playback-remux"
import type { RawSegment } from "./xml"
import type { copiedAudio } from "./live-audio"

export const PLAYBACK_TTL_MS = 6 * 60 * 60_000
export const PLAYBACK_IDLE_MS = 90_000
export const MAX_PLAYBACK_BYTES = 2 * 1024 ** 3
export const MAX_PLAYBACK_SESSIONS = 2
const DISK_RESERVE_BYTES = 512 * 1024 ** 2
type Session = {
  controller: AbortController
  timer: NodeJS.Timeout
  expiresAt: number
  touchedAt: number
  directory: string
  segments: { duration: number; bytes: number }[]
  bytes: number
  codec?: "h264" | "hevc"
  fileRange?: RawSegment["fileRange"]
  startOffsetSeconds?: number
  estimatedDurationSeconds?: number
  complete: boolean
  error?: AppError
  task?: Promise<void>
  cancelReady: (error: AppError) => void
  videoStartSeconds?: number
  audioStatus: "pending" | "available" | "unsupported"
  audio: (Omit<ReturnType<typeof copiedAudio>, "data"> & {
    bytes: number
    sequence: number
  })[]
}
type Options = {
  root?: string
  ttl?: number
  idle?: number
  maxBytes?: number
  startupMs?: number
}

// Encoded fragments are private temporary files, retained for seeking until release.
export class PlaybackSessions {
  private sessions = new Map<string, Session>()
  private initialized?: Promise<void>
  private root: string
  constructor(
    private fragments: RecordingFragments = recordingFragments,
    private options: Options = {}
  ) {
    this.root = options.root ?? join(tmpdir(), "hikvision-open-client-playback")
  }
  private initialize() {
    return (this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      // Only remove this cache's UUID directories older than the maximum lease.
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name))
          continue
        const path = join(this.root, entry.name)
        const info = await stat(path).catch(() => undefined)
        const owner = Number(
          await readFile(join(path, ".owner"), "utf8").catch(() => "")
        )
        let orphan = false
        if (Number.isInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0)
          } catch (error) {
            orphan = (error as NodeJS.ErrnoException).code === "ESRCH"
          }
        }
        if (orphan || (info && Date.now() - info.mtimeMs > PLAYBACK_TTL_MS))
          await rm(path, { recursive: true, force: true })
      }
    })())
  }
  async create(
    config: NvrConfig,
    resolve: () => Promise<RawSegment>,
    signal: AbortSignal
  ) {
    if (this.sessions.size >= MAX_PLAYBACK_SESSIONS)
      throw new AppError(
        "MEDIA_BUSY",
        429,
        "回放会话已满，请关闭其他回放后重试。"
      )
    const id = randomUUID(),
      controller = new AbortController()
    let resolveReady!: () => void
    let rejectReady!: (error: AppError) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const session: Session = {
      controller,
      timer: setInterval(() => {
        if (
          Date.now() >= session.expiresAt ||
          Date.now() - session.touchedAt >=
            (this.options.idle ?? PLAYBACK_IDLE_MS)
        )
          void this.delete(id)
      }, 1000),
      expiresAt: Date.now() + (this.options.ttl ?? PLAYBACK_TTL_MS),
      touchedAt: Date.now(),
      directory: join(this.root, id),
      segments: [],
      bytes: 0,
      complete: false,
      cancelReady: rejectReady,
      audio: [],
      audioStatus: "pending",
    }
    session.timer.unref()
    this.sessions.set(id, session)
    const abort = () => {
      void this.delete(id)
    }
    signal.addEventListener("abort", abort, { once: true })
    const startup = setTimeout(() => {
      rejectReady(
        new AppError("MEDIA_TIMEOUT", 504, "等待录像画面超时，请重试。")
      )
      controller.abort()
    }, this.options.startupMs ?? 30_000)
    if (signal.aborted) controller.abort()
    session.task = (async () => {
      await this.initialize()
      const segment = await resolve()
      // Only the service can establish whether search boundaries clipped a file.
      session.fileRange = segment.fileRange
      session.startOffsetSeconds = segment.startOffsetSeconds
      const estimatedDurationSeconds = segment.estimatedDurationSeconds
      if (
        estimatedDurationSeconds !== undefined &&
        Number.isFinite(estimatedDurationSeconds) &&
        estimatedDurationSeconds > 0
      )
        session.estimatedDurationSeconds = estimatedDurationSeconds
      if (controller.signal.aborted)
        throw new AppError("MEDIA_CANCELLED", 503, "回放已取消。")
      await mkdir(session.directory, { mode: 0o700 })
      await writeFile(join(session.directory, ".owner"), String(process.pid), {
        mode: 0o600,
      })
      const save = async (asset: string, data: Buffer) => {
        if (controller.signal.aborted)
          throw new AppError("MEDIA_CANCELLED", 503, "回放已取消。")
        if (
          session.bytes + data.length >
          (this.options.maxBytes ?? MAX_PLAYBACK_BYTES)
        )
          throw new AppError(
            "MEDIA_OUTPUT_LIMIT",
            502,
            "录像超过本次播放容量限制。"
          )
        session.bytes += data.length
        const disk = await statfs(session.directory)
        if (disk.bavail * disk.bsize < DISK_RESERVE_BYTES + data.length)
          throw new AppError(
            "MEDIA_DISK_LIMIT",
            503,
            "临时空间不足，请关闭其他回放后重试。"
          )
        await writeFile(join(session.directory, asset), data, { mode: 0o600 })
      }
      for await (const media of this.fragments(
        segment.playbackURI,
        config,
        controller.signal,
        async (audio) => {
          if ("status" in audio) {
            session.audioStatus = session.audio.length
              ? "available"
              : "unsupported"
            return
          }
          if (session.audio.length >= 120000)
            throw new AppError(
              "MEDIA_OUTPUT_LIMIT",
              502,
              "音频超过本次播放容量限制。"
            )
          const { data, ...metadata } = audio
          const sequence = session.audio.length
          await save(`audio-${sequence}.bin`, data)
          session.audio.push({ ...metadata, bytes: data.length, sequence })
          session.audioStatus = "available"
        }
      )) {
        if (controller.signal.aborted)
          throw new AppError("MEDIA_CANCELLED", 503, "回放已取消。")
        if (session.segments.length >= 43200)
          throw new AppError(
            "MEDIA_OUTPUT_LIMIT",
            502,
            "录像超过本次播放容量限制。"
          )
        if (!session.segments.length) {
          await save("init.mp4", media.init)
          session.codec = media.codec
          session.videoStartSeconds = media.startSeconds
        } else if (session.codec !== media.codec)
          throw new AppError(
            "MEDIA_UNSUPPORTED_CODEC",
            502,
            "录像中途切换编码，无法继续播放。"
          )
        await save(`${session.segments.length}.m4s`, media.media)
        session.segments.push({
          // Reordered B frames can overlap adjacent presentation spans. HLS
          // positions must follow the contiguous decode timeline, as live does.
          duration: media.decodeDurationSeconds,
          bytes: media.media.length,
        })
        if (session.segments.length === 1) {
          clearTimeout(startup)
          resolveReady()
        }
      }
      if (!session.segments.length)
        throw new AppError(
          "MEDIA_REMUX_FAILED",
          502,
          "设备未返回可播放的录像。"
        )
      session.complete = true
    })()
      .catch(async (error: unknown) => {
        session.error =
          error instanceof AppError
            ? error
            : new AppError(
                "MEDIA_REMUX_FAILED",
                502,
                "录像读取中断，请重新播放。"
              )
        controller.abort()
        rejectReady(session.error)
        await rm(session.directory, { recursive: true, force: true }).catch(
          () => {}
        )
      })
      .finally(() => clearTimeout(startup))
    try {
      await ready
      if (controller.signal.aborted || !this.sessions.has(id))
        throw (
          session.error ?? new AppError("MEDIA_CANCELLED", 503, "回放已取消。")
        )
      return {
        id,
        ...(session.fileRange && { fileRange: session.fileRange }),
        ...(session.startOffsetSeconds !== undefined && {
          startOffsetSeconds: session.startOffsetSeconds,
        }),
        playlistUrl: `/api/streams/${id}/index.m3u8`,
        durationSeconds: this.duration(session),
        ...(session.estimatedDurationSeconds !== undefined && {
          estimatedDurationSeconds: session.estimatedDurationSeconds,
        }),
        ...(session.complete && {
          totalDurationSeconds: this.duration(session),
        }),
        expiresAt: new Date(session.expiresAt).toISOString(),
        mode: "stream-copy" as const,
        codec: session.codec!,
      }
    } catch (error) {
      await this.delete(id)
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }
  private duration(session: Session) {
    return session.segments.reduce((sum, segment) => sum + segment.duration, 0)
  }
  private get(id: string) {
    const session = this.sessions.get(id)
    if (
      !session ||
      Date.now() >= session.expiresAt ||
      Date.now() - session.touchedAt >= (this.options.idle ?? PLAYBACK_IDLE_MS)
    ) {
      void this.delete(id)
      throw new AppError("MEDIA_NOT_FOUND", 404, "回放已结束，请重新播放。")
    }
    session.touchedAt = Date.now()
    if (session.error) throw session.error
    return session
  }
  status(id: string) {
    const session = this.get(id)
    return {
      complete: session.complete,
      durationSeconds: this.duration(session),
      ...(session.estimatedDurationSeconds !== undefined && {
        estimatedDurationSeconds: session.estimatedDurationSeconds,
      }),
      ...(session.complete && { totalDurationSeconds: this.duration(session) }),
    }
  }
  async audio(id: string, after: number, at: number) {
    const session = this.get(id),
      offset = session.videoStartSeconds ?? 0
    const selected = session.audio
      .filter(
        (chunk) =>
          chunk.sequence > after &&
          chunk.startSeconds <= offset + at + 3 &&
          chunk.startSeconds + chunk.bytes / chunk.sampleRate / chunk.channels >
            offset + at - 0.5
      )
      .slice(0, 16)
    const chunks = await Promise.all(
      selected.map(async (chunk) => ({
        codec: chunk.codec,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        startSeconds: chunk.startSeconds,
        sequence: chunk.sequence,
        data: (
          await readFile(join(session.directory, `audio-${chunk.sequence}.bin`))
        ).toString("base64"),
      }))
    )
    return {
      status:
        session.audioStatus === "pending" && session.complete
          ? "unsupported"
          : session.audioStatus,
      videoStartSeconds: offset,
      chunks,
    }
  }
  playlist(id: string) {
    const session = this.get(id)
    return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${Math.max(1, ...session.segments.map((segment) => Math.ceil(segment.duration)))}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n${session.segments.map((segment, index) => `#EXTINF:${segment.duration.toFixed(6)},\n${index}.m4s\n`).join("")}${session.complete ? "#EXT-X-ENDLIST\n" : ""}`
  }
  async asset(id: string, asset: string): Promise<Buffer> {
    const session = this.get(id)
    const match = /^(0|[1-9]\d{0,5})\.m4s$/.exec(asset)
    if (
      asset !== "init.mp4" &&
      (!match || Number(match[1]) >= session.segments.length)
    )
      throw new AppError("MEDIA_NOT_FOUND", 404, "媒体资源不存在。")
    try {
      return await readFile(join(session.directory, asset))
    } catch {
      throw new AppError("MEDIA_NOT_FOUND", 404, "媒体资源已清理。")
    }
  }
  async delete(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    clearInterval(session.timer)
    session.controller.abort()
    session.cancelReady(new AppError("MEDIA_CANCELLED", 503, "回放已取消。"))
    await session.task
    await rm(session.directory, { recursive: true, force: true }).catch(
      () => {}
    )
  }
  async dispose() {
    await Promise.all([...this.sessions.keys()].map((id) => this.delete(id)))
  }
}
