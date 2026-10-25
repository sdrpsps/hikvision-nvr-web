import { boxes, readMp4Init } from "./mp4-init"
import {
  concatBytes,
  MAX_MEDIA_BUFFER,
  u32,
  u64,
  type AudioConfig,
  type EncodedPacket,
  type VideoConfig,
} from "./types"

type Sample = {
  pts: number
  dts: number
  duration: number
  size: number
  offset: number
  keyframe: boolean
}

// Parses encoded samples only. No browser decoder or encoder is involved.
export class FragmentedMp4Demuxer {
  private pending = new Uint8Array(0)
  private position = 0
  private moofStart = 0
  private samples: Sample[] = []
  private timescale = 0
  private trackId = 0
  private defaultDuration = 0
  private defaultSize = 0
  private defaultFlags = 0
  private sawMedia = false
  video?: VideoConfig
  audio?: AudioConfig

  push(chunk: Uint8Array): EncodedPacket[] {
    if (this.pending.length + chunk.length > MAX_MEDIA_BUFFER)
      throw new Error("单个媒体分片超过浏览器缓冲上限。")
    this.pending = concatBytes(this.pending, chunk)
    const result: EncodedPacket[] = []
    while (this.pending.length >= 8) {
      let size = u32(this.pending, 0),
        header = 8
      if (size === 1) {
        if (this.pending.length < 16) break
        size = u64(this.pending, 8)
        header = 16
      }
      if (!size || size < header || size > MAX_MEDIA_BUFFER)
        throw new Error("MP4 分片大小无效。")
      if (this.pending.length < size) break
      const type = String.fromCharCode(...this.pending.subarray(4, 8)),
        data = this.pending.subarray(header, size)
      if (type === "moov") this.readInit(data)
      else if (type === "moof") {
        if (this.samples.length) throw new Error("MP4 分片缺少媒体数据。")
        this.moofStart = this.position
        this.readFragment(data)
      } else if (type === "mdat") {
        if (!this.timescale || (!this.video && !this.audio))
          throw new Error("媒体缺少可用的编码参数。")
        const dataStart = this.position + header - this.moofStart
        for (let index = 0; index < this.samples.length;) {
          const sample = this.samples[index]
          const start = sample.offset - dataStart
          if (start < 0 || start + sample.size > data.length)
            throw new Error("媒体样本范围无效。")
          if (this.audio) {
            // G.711 often has one sample per byte. Coalesce contiguous samples so
            // packet count and memory stay bounded by each fragment, not its rate.
            let count = 1,
              size = sample.size,
              duration = sample.duration
            while (index + count < this.samples.length) {
              const next = this.samples[index + count]
              if (
                next.offset !== sample.offset + size ||
                Math.abs(next.dts - (sample.dts + duration)) > 1e-6
              )
                break
              size += next.size
              duration += next.duration
              count++
            }
            result.push({
              kind: "audio",
              codec: this.audio.codec,
              pts: sample.pts,
              dts: sample.dts,
              duration,
              keyframe: true,
              data: data.slice(start, start + size),
              audio: this.audio,
            })
            index += count
          } else {
            result.push({
              kind: "video",
              codec: this.video!.codec,
              pts: sample.pts,
              dts: sample.dts,
              duration: sample.duration,
              keyframe: sample.keyframe,
              data: data.slice(start, start + sample.size),
              video: this.video,
            })
            index++
          }
        }
        this.samples = []
        this.sawMedia = true
      }
      this.pending = this.pending.slice(size)
      this.position += size
    }
    return result
  }

  finish() {
    if (this.pending.length || this.samples.length)
      throw new Error("媒体流中途结束，最后一个分片不完整。")
    if (!this.sawMedia) throw new Error("未收到可保存的音视频数据。")
    return [] as EncodedPacket[]
  }

  private readInit(data: Uint8Array) {
    const init = readMp4Init(data)
    this.trackId = init.trackId
    this.timescale = init.timescale
    this.video = init.video
    this.audio = init.audio
    this.defaultDuration = init.defaultDuration ?? this.defaultDuration
    this.defaultSize = init.defaultSize ?? this.defaultSize
    this.defaultFlags = init.defaultFlags ?? this.defaultFlags
  }

  private readFragment(data: Uint8Array) {
    const trafs = boxes(data).filter((box) => box.type === "traf")
    let previousEnd = 0
    for (const traf of trafs) {
      const parts = boxes(traf.data),
        tfhd = parts.find((box) => box.type === "tfhd"),
        tfdt = parts.find((box) => box.type === "tfdt")
      if (!tfhd || !tfdt || u32(tfhd.data, 4) !== this.trackId)
        throw new Error("媒体分片的轨道参数无效。")
      const flags = u32(tfhd.data, 0) & 0xffffff
      let at = 8,
        baseOffset = 0
      if (flags & 1) {
        baseOffset = u64(tfhd.data, at) - this.moofStart
        at += 8
      }
      if (flags & 2) at += 4
      const duration = flags & 8 ? u32(tfhd.data, at) : this.defaultDuration
      if (flags & 8) at += 4
      const size = flags & 16 ? u32(tfhd.data, at) : this.defaultSize
      if (flags & 16) at += 4
      const sampleFlags = flags & 32 ? u32(tfhd.data, at) : this.defaultFlags
      let timestamp = tfdt.data[0] === 1 ? u64(tfdt.data, 4) : u32(tfdt.data, 4)
      for (const trun of parts.filter((box) => box.type === "trun")) {
        const f = u32(trun.data, 0) & 0xffffff,
          count = u32(trun.data, 4)
        if (count > 500_000 || this.samples.length + count > 500_000)
          throw new Error("单个媒体分片包含过多样本。")
        at = 8
        let offset = previousEnd
        if (f & 1) {
          let relative = u32(trun.data, at)
          if (relative > 0x7fffffff) relative -= 0x100000000
          offset = baseOffset + relative
          at += 4
        }
        const firstFlags = f & 4 ? u32(trun.data, at) : undefined
        if (f & 4) at += 4
        for (let i = 0; i < count; i++) {
          const length = f & 0x100 ? u32(trun.data, at) : duration
          if (f & 0x100) at += 4
          const bytes = f & 0x200 ? u32(trun.data, at) : size
          if (f & 0x200) at += 4
          const sf =
            f & 0x400
              ? u32(trun.data, at)
              : i === 0
                ? (firstFlags ?? sampleFlags)
                : sampleFlags
          if (f & 0x400) at += 4
          let composition = f & 0x800 ? u32(trun.data, at) : 0
          if (f & 0x800) {
            if (trun.data[0] === 1 && composition > 0x7fffffff)
              composition -= 0x100000000
            at += 4
          }
          if (!length || !bytes || bytes > MAX_MEDIA_BUFFER)
            throw new Error("媒体样本长度无效。")
          this.samples.push({
            pts: (timestamp + composition) / this.timescale,
            dts: timestamp / this.timescale,
            duration: length / this.timescale,
            size: bytes,
            offset,
            keyframe: !(sf & 0x10000),
          })
          timestamp += length
          offset += bytes
        }
        previousEnd = offset
      }
    }
  }
}
