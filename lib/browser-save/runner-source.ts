import {
  FragmentedMp4Demuxer,
  MpegPsDemuxer,
  type EncodedPacket,
} from "../media-export"
import type { SaveSource } from "./types"

type MediaConsumer = {
  consume(packets: EncodedPacket[]): Promise<void>
  audioUnsupported(): void
  reachedEnd(): boolean
}

// Owns the transport reader, decoder state, and bounded live-frame buffer.
export class SaveMediaSource {
  private video = new FragmentedMp4Demuxer()
  private audio = new FragmentedMp4Demuxer()
  private ps = new MpegPsDemuxer()
  private pending = new Uint8Array(0)

  private constructor(
    private readonly source: SaveSource,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  ) {}

  static async open(source: SaveSource, signal: AbortSignal) {
    const body =
      source.mode === "live"
        ? { track: source.track }
        : {
            track: source.track,
            date: source.date,
            segmentId: source.segmentId,
          }
    const response = await fetch(`/api/transfers/${source.mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.error?.message ?? "无法读取录像源，请重试。")
    }
    if (!response.body) throw new Error("浏览器未收到媒体数据。")
    return new SaveMediaSource(source, response.body.getReader())
  }

  async read(boundaryStartedAt?: number) {
    if (boundaryStartedAt === undefined) return this.reader.read()
    const remaining = 3000 - (Date.now() - boundaryStartedAt)
    if (remaining <= 0) {
      throw new Error("等待音轨覆盖边界超时，已停止并保留可用部分。")
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("等待音轨覆盖边界超时，已停止并保留可用部分。")),
            remaining
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  async push(bytes: Uint8Array, consumer: MediaConsumer) {
    if (this.source.mode === "history") {
      const packets = this.ps.push(bytes)
      if (this.ps.audioUnsupported) consumer.audioUnsupported()
      await consumer.consume(packets)
      return
    }
    const next = new Uint8Array(this.pending.length + bytes.length)
    next.set(this.pending)
    next.set(bytes, this.pending.length)
    this.pending = next
    while (this.pending.length >= 5) {
      const length = new DataView(
        this.pending.buffer,
        this.pending.byteOffset
      ).getUint32(1)
      if (length > 16 * 1024 * 1024) throw new Error("实时媒体块超出安全大小。")
      if (this.pending.length < length + 5) break
      const kind = this.pending[0]
      const frame = this.pending.slice(5, 5 + length)
      this.pending = this.pending.slice(5 + length)
      if (kind === 1) await consumer.consume(this.video.push(frame))
      else if (kind === 2) await consumer.consume(this.audio.push(frame))
      else if (kind === 3) {
        const event = JSON.parse(new TextDecoder().decode(frame))
        if (event.type === "audio" && event.status === "unsupported")
          consumer.audioUnsupported()
        if (event.type === "error")
          throw new Error(event.message ?? "实时媒体中断。")
        if (event.type === "end") {
          if (!consumer.reachedEnd()) {
            throw new Error(
              event.reason === "timeout"
                ? "实时录制连接已达到最长时限，录制提前结束。"
                : "实时录制连接提前结束。"
            )
          }
          break
        }
      } else throw new Error("实时媒体传输格式无效。")
    }
    if (this.pending.byteLength > 16 * 1024 * 1024 + 5)
      throw new Error("媒体接收缓冲超过上限。")
  }

  async finish(consumer: MediaConsumer) {
    if (this.source.mode !== "history") return
    const packets = this.ps.finish()
    if (this.ps.audioUnsupported) consumer.audioUnsupported()
    await consumer.consume(packets)
  }

  cancel() {
    return this.reader.cancel()
  }
}
