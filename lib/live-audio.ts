import type { z } from "zod"
import type { liveAudioSchema } from "@/shared/contracts"
import { decodeG711 } from "@/lib/g711"

export type AudioLoader = (request: {
  after: number
  at?: number
  signal: AbortSignal
}) => Promise<z.infer<typeof liveAudioSchema>>

type Block = { start: number; buffer: AudioBuffer; scheduled: boolean }
export class LocalLiveAudio {
  private context = new AudioContext()
  private controller = new AbortController()
  private blocks: Block[] = []
  private sources = new Set<AudioBufferSourceNode>()
  private tick: ReturnType<typeof setInterval>
  private pollTimer?: ReturnType<typeof setTimeout>
  private cursor = -1
  private fallbackOffset = 0
  private emptyPolls = 0
  private closed = false
  private waiting = true
  private revision = 0
  private polling = false
  private seek = () => {
    this.pause()
    if (this.playback) {
      this.revision++
      this.blocks = []
      this.cursor = -1
      this.emptyPolls = 0
    }
  }
  private rateChange = () => {
    this.stopSources()
    this.schedule()
  }
  private pause = () => {
    this.waiting = true
    this.stopSources()
  }
  private playing = () => {
    this.waiting = false
  }
  constructor(
    private video: HTMLVideoElement,
    private loadAudio: AudioLoader,
    private ptsOffset: () => number | undefined,
    private onError: (message: string) => void,
    private playback = false
  ) {
    this.waiting = video.paused || video.readyState < 3
    for (const event of ["waiting", "pause", "ended"])
      video.addEventListener(event, this.pause)
    video.addEventListener("seeking", this.seek)
    video.addEventListener("ratechange", this.rateChange)
    for (const event of ["playing", "seeked"])
      video.addEventListener(event, this.playing)
    this.tick = setInterval(() => this.schedule(), 100)
  }
  async start() {
    await this.context.resume()
    if (this.closed) return
    if (this.context.state !== "running")
      throw new Error("浏览器尚未允许声音，请再次点击开启声音。")
    void this.poll()
  }
  private async poll() {
    if (this.closed || this.polling) return
    this.polling = true
    const revision = this.revision
    try {
      const result = await this.loadAudio({
        after: this.cursor,
        at: this.playback ? this.video.currentTime : undefined,
        signal: this.controller.signal,
      })
      if (this.closed) return
      if (revision !== this.revision) return
      if (result.status === "unsupported")
        throw new Error("未检测到受支持的音轨，视频可继续播放。")
      if (result.status === "pending" && ++this.emptyPolls > 5)
        throw new Error("未收到可播放的音轨。")
      this.fallbackOffset = result.videoStartSeconds
      for (const chunk of result.chunks) {
        const bytes = Uint8Array.from(atob(chunk.data), (char) =>
          char.charCodeAt(0)
        )
        if (!bytes.length || bytes.length % chunk.channels)
          throw new Error("音频数据不完整，请重新开启声音。")
        const samples = decodeG711(bytes, chunk.codec)
        const buffer = this.context.createBuffer(
          chunk.channels,
          bytes.length / chunk.channels,
          chunk.sampleRate
        )
        for (let channel = 0; channel < chunk.channels; channel++) {
          const output = buffer.getChannelData(channel)
          for (let i = 0; i < output.length; i++)
            output[i] = samples[i * chunk.channels + channel]
        }
        this.blocks.push({
          start: chunk.startSeconds,
          buffer,
          scheduled: false,
        })
        this.cursor = chunk.sequence
      }
      this.blocks = this.blocks.slice(-80)
      this.schedule()
    } catch (error) {
      if (!this.closed) {
        this.onError(
          error instanceof Error ? error.message : "声音加载失败，请重试。"
        )
        this.close()
      }
    } finally {
      this.polling = false
      if (!this.closed) this.pollTimer = setTimeout(() => void this.poll(), 500)
    }
  }
  private schedule() {
    if (
      this.closed ||
      this.waiting ||
      this.video.paused ||
      this.video.seeking ||
      this.video.readyState < 3
    )
      return
    const now = this.video.currentTime,
      offset = this.ptsOffset() ?? this.fallbackOffset
    this.blocks = this.blocks.filter(
      (block) => block.start - offset + block.buffer.duration > now
    )
    for (const block of this.blocks) {
      const start = block.start - offset
      if (block.scheduled || start > now + 0.4) continue
      const skip = Math.max(0, now - start)
      if (skip >= block.buffer.duration) continue
      const source = this.context.createBufferSource()
      source.buffer = block.buffer
      source.playbackRate.value = this.video.playbackRate
      source.connect(this.context.destination)
      source.onended = () => {
        this.sources.delete(source)
        source.disconnect()
      }
      this.sources.add(source)
      block.scheduled = true
      source.start(
        this.context.currentTime +
          Math.max(0, start - now) / this.video.playbackRate +
          0.02,
        skip
      )
    }
  }
  private stopSources() {
    for (const source of this.sources) {
      source.stop()
      source.disconnect()
    }
    this.sources.clear()
    for (const block of this.blocks) block.scheduled = false
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.controller.abort()
    clearInterval(this.tick)
    clearTimeout(this.pollTimer)
    this.stopSources()
    this.blocks = []
    for (const event of ["waiting", "pause", "ended"])
      this.video.removeEventListener(event, this.pause)
    this.video.removeEventListener("seeking", this.seek)
    this.video.removeEventListener("ratechange", this.rateChange)
    for (const event of ["playing", "seeked"])
      this.video.removeEventListener(event, this.playing)
    void this.context.close().catch(() => {})
  }
}
