import { liveAudioSchema } from "@/shared/contracts"
import { getJson } from "@/lib/api"
import { decodeG711 } from "@/lib/g711"

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
  private pause = () => {
    this.waiting = true
    this.stopSources()
  }
  private playing = () => {
    this.waiting = false
  }
  constructor(
    private video: HTMLVideoElement,
    private id: string,
    private ptsOffset: () => number | undefined,
    private onError: (message: string) => void
  ) {
    this.waiting = video.paused || video.readyState < 3
    for (const event of ["waiting", "pause", "seeking"])
      video.addEventListener(event, this.pause)
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
    try {
      const result = await getJson(
        `/api/streams/${this.id}/audio?after=${this.cursor}`,
        liveAudioSchema,
        this.controller.signal
      )
      if (this.closed) return
      if (result.status === "unsupported")
        throw new Error("此通道音频格式暂不支持本机播放，视频可继续预览。")
      if (result.status === "pending" && ++this.emptyPolls > 5)
        throw new Error("未收到可播放的音轨，请确认此通道已启用音频。")
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
      this.pollTimer = setTimeout(() => void this.poll(), 500)
    } catch (error) {
      if (!this.closed) {
        this.onError(
          error instanceof Error ? error.message : "声音加载失败，请重试。"
        )
        this.close()
      }
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
      source.connect(this.context.destination)
      source.onended = () => {
        this.sources.delete(source)
        source.disconnect()
      }
      this.sources.add(source)
      block.scheduled = true
      source.start(
        this.context.currentTime + Math.max(0, start - now) + 0.02,
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
    for (const event of ["waiting", "pause", "seeking"])
      this.video.removeEventListener(event, this.pause)
    for (const event of ["playing", "seeked"])
      this.video.removeEventListener(event, this.playing)
    void this.context.close().catch(() => {})
  }
}
