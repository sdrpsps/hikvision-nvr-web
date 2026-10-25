import {
  concatBytes,
  MAX_MEDIA_BUFFER,
  type AudioConfig,
  type ByteWriter,
  type EncodedPacket,
  type MuxerStats,
  type VideoConfig,
} from "./types"

const text = new TextEncoder()
function integer(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("保存文件的时间或大小超出支持范围。")
  const bytes: number[] = []
  do {
    bytes.unshift(value % 256)
    value = Math.floor(value / 256)
  } while (value)
  return Uint8Array.from(bytes)
}
function size(value: number) {
  for (let length = 1; length <= 8; length++) {
    if (value < 2 ** (length * 7) - 1) {
      const bytes = new Uint8Array(length)
      for (let i = length - 1; i >= 0; i--) {
        bytes[i] = value % 256
        value = Math.floor(value / 256)
      }
      bytes[0] |= 1 << (8 - length)
      return bytes
    }
  }
  throw new Error("媒体块过大。")
}
function element(id: number, bytes: Uint8Array) {
  return concatBytes(integer(id), size(bytes.length), bytes)
}
function uint(id: number, value: number) {
  return element(id, integer(value))
}
function str(id: number, value: string) {
  return element(id, text.encode(value))
}
function master(id: number, ...children: Uint8Array[]) {
  return element(id, concatBytes(...children))
}
function float(value: number) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value)
  return bytes
}
function videoTrack(config: VideoConfig, frameDuration?: number) {
  return master(
    0xae,
    uint(0xd7, 1),
    uint(0x73c5, 1),
    uint(0x83, 1),
    uint(0x9c, 0),
    str(0x86, config.codec === "h264" ? "V_MPEG4/ISO/AVC" : "V_MPEGH/ISO/HEVC"),
    element(0x63a2, config.codecPrivate),
    ...(frameDuration
      ? [uint(0x23e383, Math.round(frameDuration * 1_000_000_000))]
      : []),
    master(0xe0, uint(0xb0, config.width), uint(0xba, config.height))
  )
}
function audioTrack(config: AudioConfig) {
  const format = new Uint8Array(18),
    view = new DataView(format.buffer)
  view.setUint16(0, config.codec === "alaw" ? 6 : 7, true)
  view.setUint16(2, config.channels, true)
  view.setUint32(4, config.sampleRate, true)
  view.setUint32(8, config.sampleRate * config.channels, true)
  view.setUint16(12, config.channels, true)
  view.setUint16(14, 8, true)
  return master(
    0xae,
    uint(0xd7, 2),
    uint(0x73c5, 2),
    uint(0x83, 2),
    uint(0x9c, 0),
    str(0x86, "A_MS/ACM"),
    element(0x63a2, format),
    master(
      0xe1,
      element(0xb5, float(config.sampleRate)),
      uint(0x9f, config.channels),
      uint(0x6264, 8)
    )
  )
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

export type MatroskaOptions = {
  audio?: AudioConfig | null
  waitForAudioSeconds?: number
}

// Streaming Matroska: one small cluster at a time, bounded start-up queue and
// at most 2048 sparse seek points. No full-file buffer or growing sample index.
export class MatroskaMuxer {
  readonly stats: MuxerStats = {
    bytesWritten: 0,
    videoPackets: 0,
    audioPackets: 0,
    durationSeconds: 0,
  }
  private video?: VideoConfig
  private audio?: AudioConfig
  private headerWritten = false
  private pending: EncodedPacket[] = []
  private pendingBytes = 0
  private firstMediaPts?: number
  private durationOffset = 0
  private segmentOffset = 0
  private finished = false
  private cues: { time: number; position: number }[] = []
  private cueInterval = 1000
  private lastCue = -Infinity
  private videoDefaultDuration?: number
  private videoEndPts?: number
  private queuedAudio: EncodedPacket[] = []
  private queuedAudioBytes = 0

  constructor(
    private writer: ByteWriter,
    private options: MatroskaOptions = {}
  ) {
    this.audio = options.audio ?? undefined
  }

  async add(packet: EncodedPacket) {
    if (this.finished) throw new Error("保存文件已经结束。")
    if (packet.kind === "audio" && this.options.audio === null) return
    if (
      !Number.isFinite(packet.pts) ||
      !packet.data.length ||
      packet.data.length > MAX_MEDIA_BUFFER
    )
      throw new Error("媒体数据或时间戳无效。")
    if (packet.video) {
      this.videoDefaultDuration ??=
        packet.duration ?? packet.video.frameDuration
      if (
        this.headerWritten &&
        this.video &&
        (this.video.codec !== packet.video.codec ||
          this.video.width !== packet.video.width ||
          this.video.height !== packet.video.height ||
          !sameBytes(this.video.codecPrivate, packet.video.codecPrivate))
      )
        throw new Error("录制期间视频编码发生变化，已保存部分需要单独保留。")
      this.video = packet.video
    }
    if (packet.audio) {
      if (this.headerWritten && !this.audio)
        throw new Error("音轨延迟出现，需要重新开始带声音的录制。")
      if (
        this.audio &&
        (this.audio.codec !== packet.audio.codec ||
          this.audio.sampleRate !== packet.audio.sampleRate ||
          this.audio.channels !== packet.audio.channels)
      )
        throw new Error("录制期间音频编码发生变化，已保存部分需要单独保留。")
      this.audio = packet.audio
    }
    if (this.headerWritten) return this.writePacket(packet)
    this.firstMediaPts ??= packet.pts
    this.pendingBytes += packet.data.length
    if (this.pendingBytes > MAX_MEDIA_BUFFER)
      throw new Error("等待录制起点或音轨时超过缓冲上限。")
    this.pending.push(packet)
    const keyframe = this.pending.find(
      (value) => value.kind === "video" && value.keyframe
    )
    if (!this.video || !keyframe) return
    const waited = packet.pts - (this.firstMediaPts ?? packet.pts)
    if (
      !this.audio &&
      this.options.audio !== null &&
      waited < (this.options.waitForAudioSeconds ?? 2)
    )
      return
    await this.start(keyframe.pts)
  }

  async finish() {
    if (this.finished) return this.stats
    if (!this.headerWritten) {
      const keyframe = this.pending.find(
        (value) => value.kind === "video" && value.keyframe
      )
      if (!keyframe || !this.video)
        throw new Error("未收到完整关键帧，无法生成可播放的录像。")
      await this.start(keyframe.pts)
    }
    if (!this.stats.videoPackets) throw new Error("未保存有效视频。")
    await this.flushAudio(true)
    if (this.cues.length) {
      await this.write(
        master(
          0x1c53bb6b,
          ...this.cues.map((cue) =>
            master(
              0xbb,
              uint(0xb3, cue.time),
              master(0xb7, uint(0xf7, 1), uint(0xf1, cue.position))
            )
          )
        )
      )
    }
    if (this.writer.seek) {
      await this.writer.seek(this.durationOffset)
      await this.writer.write(float(this.stats.durationSeconds * 1000))
      await this.writer.seek(this.stats.bytesWritten)
    }
    this.finished = true
    return this.stats
  }

  private async start(origin: number) {
    this.stats.startPts = origin
    const ebml = master(
      0x1a45dfa3,
      uint(0x4286, 1),
      uint(0x42f7, 1),
      uint(0x42f2, 4),
      uint(0x42f3, 8),
      str(0x4282, "matroska"),
      uint(0x4287, 4),
      uint(0x4285, 2)
    )
    const segment = Uint8Array.from([
      0x18, 0x53, 0x80, 0x67, 1, 255, 255, 255, 255, 255, 255, 255,
    ])
    // Sequential browser downloads cannot patch headers. Omitting Duration
    // permits readers to infer it; Duration=0 advertises an empty recording.
    const duration = this.writer.seek
      ? element(0x4489, float(0))
      : new Uint8Array(0)
    const info = master(
      0x1549a966,
      uint(0x2ad7b1, 1_000_000),
      str(0x4d80, "NVR Web Console"),
      str(0x5741, "NVR Web Console"),
      duration
    )
    const header = concatBytes(
      ebml,
      segment,
      info,
      master(
        0x1654ae6b,
        videoTrack(this.video!, this.videoDefaultDuration),
        ...(this.audio ? [audioTrack(this.audio)] : [])
      )
    )
    this.segmentOffset = ebml.length + segment.length
    this.durationOffset = ebml.length + segment.length + info.length - 8
    await this.write(header)
    this.headerWritten = true
    const pending = this.pending
    this.pending = []
    this.pendingBytes = 0
    let started = false
    for (const packet of pending) {
      if (packet.kind === "video" && packet.keyframe && packet.pts === origin)
        started = true
      if (packet.kind === "video" && !started) continue
      await this.writePacket(packet)
    }
  }

  private async writePacket(packet: EncodedPacket) {
    if (packet.kind === "audio") {
      this.queuedAudio.push(packet)
      this.queuedAudioBytes += packet.data.length
      if (this.queuedAudioBytes > 2 * 1024 * 1024)
        throw new Error("音频超前视频过多，已停止以避免占用过多内存。")
      await this.flushAudio(false)
      return
    }
    await this.writeMediaPacket(packet)
    this.videoEndPts = Math.max(
      this.videoEndPts ?? packet.pts,
      packet.pts + (packet.duration ?? this.videoDefaultDuration ?? 0.04)
    )
    await this.flushAudio(false)
  }

  private async flushAudio(final: boolean) {
    if (!this.audio || this.videoEndPts === undefined) return
    while (this.queuedAudio.length) {
      const packet = this.queuedAudio[0]
      const frameBytes = this.audio.channels
      const frames = Math.min(
        packet.data.length / frameBytes,
        Math.floor(
          (this.videoEndPts - packet.pts) * this.audio.sampleRate + 0.000001
        )
      )
      if (frames <= 0) break
      const bytes = frames * frameBytes
      this.queuedAudioBytes -= bytes
      if (bytes === packet.data.length) this.queuedAudio.shift()
      else
        this.queuedAudio[0] = {
          ...packet,
          pts: packet.pts + frames / this.audio.sampleRate,
          dts: undefined,
          data: packet.data.subarray(bytes),
          duration:
            (packet.data.length - bytes) / frameBytes / this.audio.sampleRate,
        }
      await this.writeMediaPacket({
        ...packet,
        data: packet.data.subarray(0, bytes),
        duration: frames / this.audio.sampleRate,
      })
    }
    if (final) {
      this.queuedAudio = []
      this.queuedAudioBytes = 0
    }
  }

  private async writeMediaPacket(packet: EncodedPacket) {
    const origin = this.stats.startPts!
    if (packet.pts < origin - 0.000001) {
      if (packet.kind !== "audio" || !this.audio) return
      const frames = Math.ceil((origin - packet.pts) * this.audio.sampleRate)
      const skip = frames * this.audio.channels
      if (skip >= packet.data.length) return
      packet = {
        ...packet,
        pts: packet.pts + frames / this.audio.sampleRate,
        dts: undefined,
        duration:
          (packet.data.length - skip) /
          this.audio.sampleRate /
          this.audio.channels,
        data: packet.data.subarray(skip),
      }
    }
    if (packet.kind === "audio" && !this.audio) return
    const pts = Math.round((packet.pts - origin) * 1000)
    const clusterTime = Math.max(
      0,
      Math.round(((packet.dts ?? packet.pts) - origin) * 1000)
    )
    const relative = pts - clusterTime
    if (relative < -32768 || relative > 32767)
      throw new Error("媒体解码与显示时间戳相差过大。")
    const prefix = new Uint8Array(4)
    prefix[0] = packet.kind === "video" ? 0x81 : 0x82
    new DataView(prefix.buffer).setInt16(1, relative)
    prefix[3] = packet.keyframe ? 0x80 : 0
    const position = this.stats.bytesWritten - this.segmentOffset
    await this.write(
      master(
        0x1f43b675,
        uint(0xe7, clusterTime),
        element(0xa3, concatBytes(prefix, packet.data))
      )
    )
    if (packet.kind === "video") {
      this.stats.videoPackets++
      if (packet.keyframe && pts - this.lastCue >= this.cueInterval) {
        this.cues.push({ time: pts, position })
        this.lastCue = pts
        if (this.cues.length > 2048) {
          this.cues = this.cues.filter((_, index) => index % 2 === 0)
          this.cueInterval *= 2
        }
      }
    } else this.stats.audioPackets++
    this.stats.endPts = Math.max(
      this.stats.endPts ?? origin,
      packet.pts + (packet.duration ?? (packet.kind === "video" ? 0.04 : 0))
    )
    this.stats.durationSeconds = this.stats.endPts - origin
  }

  private async write(data: Uint8Array) {
    await this.writer.write(data)
    this.stats.bytesWritten += data.length
  }
}
