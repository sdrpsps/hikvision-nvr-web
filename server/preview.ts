import { randomUUID } from "node:crypto"
import type { NvrConfig } from "./config"
import { AppError } from "./errors"
import { remuxRecording, type Remuxer, type PreviewMedia } from "./remux"
import type { RawSegment } from "./xml"

export const SESSION_TTL_MS = 120000
export const MAX_PREVIEW_SESSIONS = 2
type Session = {
  controller: AbortController
  timer: NodeJS.Timeout
  expiresAt: number
  media?: PreviewMedia
}
export class PreviewSessions {
  private sessions = new Map<string, Session>()
  constructor(
    private remux: Remuxer = remuxRecording,
    private ttl = SESSION_TTL_MS
  ) {}
  async create(
    config: NvrConfig,
    resolve: () => Promise<RawSegment>,
    signal: AbortSignal
  ) {
    if (this.sessions.size >= MAX_PREVIEW_SESSIONS)
      throw new AppError(
        "MEDIA_BUSY",
        429,
        "预览会话已满，请关闭已有预览后重试。"
      )
    const id = randomUUID(),
      controller = new AbortController(),
      expiresAt = Date.now() + this.ttl
    const timer = setTimeout(() => this.delete(id), this.ttl)
    timer.unref()
    const session: Session = { controller, timer, expiresAt }
    this.sessions.set(id, session)
    const abort = () => this.delete(id)
    signal.addEventListener("abort", abort, { once: true })
    try {
      if (signal.aborted) abort()
      const segment = await resolve()
      if (controller.signal.aborted)
        throw new AppError("MEDIA_CANCELLED", 503, "预览已取消。")
      // Search metadata can misreport HEVC as H.264. Trust the copied media container.
      const media = await this.remux(
        segment.playbackURI,
        config,
        controller.signal
      )
      if (controller.signal.aborted)
        throw new AppError("MEDIA_CANCELLED", 503, "预览已取消或超时。")
      session.media = media
      return {
        id,
        playlistUrl: `/api/streams/${id}/index.m3u8`,
        durationSeconds: media.durationSeconds,
        expiresAt: new Date(expiresAt).toISOString(),
        mode: "stream-copy" as const,
        codec: media.codec,
      }
    } catch (error) {
      this.delete(id)
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }
  get(id: string) {
    const session = this.sessions.get(id)
    if (!session?.media || session.expiresAt <= Date.now()) {
      if (session && session.expiresAt <= Date.now()) this.delete(id)
      throw new AppError(
        "MEDIA_NOT_FOUND",
        404,
        "预览不存在或已过期，请重新打开。"
      )
    }
    return session.media
  }
  playlist(id: string) {
    const { durationSeconds } = this.get(id)
    return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${Math.ceil(durationSeconds)}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:${durationSeconds.toFixed(6)},\nsegment.m4s\n#EXT-X-ENDLIST\n`
  }
  delete(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    clearTimeout(session.timer)
    session.controller.abort()
    session.media = undefined
  }
  dispose() {
    for (const id of this.sessions.keys()) this.delete(id)
  }
}
