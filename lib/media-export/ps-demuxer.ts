import { AnnexBVideo, lengthPrefixed, nalBoundary } from "./nal"
import {
  concatBytes,
  MAX_MEDIA_BUFFER,
  u16,
  type EncodedPacket,
  type VideoCodec,
} from "./types"

// private_stream_1 can carry mapped audio or unrelated private metadata.
const UNSUPPORTED_AUDIO_STREAM_TYPES = new Set([
  0x03, 0x04, 0x0f, 0x11, 0x1c, 0x81, 0x87, 0x92, 0x93,
])

function pts(bytes: Uint8Array, offset: number) {
  if (offset + 5 > bytes.length) throw new Error("录像时间戳不完整。")
  return (
    ((bytes[offset] >>> 1) & 7) * 0x40000000 +
    bytes[offset + 1] * 0x400000 +
    (bytes[offset + 2] >>> 1) * 0x8000 +
    bytes[offset + 3] * 128 +
    (bytes[offset + 4] >>> 1)
  )
}

function packetStart(bytes: Uint8Array, from = 0) {
  for (let i = from; i + 3 < bytes.length; i++)
    if (
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 1 &&
      bytes[i + 3] >= 0xb9
    )
      return i
  return -1
}

// Hikvision's IMKH prefix is skipped while finding standard program-stream
// packet boundaries. Only encoded PES media enters the output.
export class MpegPsDemuxer {
  private pending = new Uint8Array(0)
  private video = new AnnexBVideo()
  private streamTypes = new Map<number, number>()
  private videoPending = new Uint8Array(0)
  private videoPosition = 0
  private videoReceived = 0
  private timeMarkers: { offset: number; pts: number; dts?: number }[] = []
  private nextVideoTime?: { pts: number; dts?: number }
  private currentVideoTime?: { pts: number; dts?: number }
  private lastVideoTime?: { pts: number; dts?: number }
  private currentNals: Uint8Array[] = []
  private currentVideoBytes = 0
  private hasVideoSlice = false
  private timestampReference?: number
  private mediaPackets = 0
  private scannedBytes = 0
  private frameDuration = 0.04
  audioUnsupported = false
  firstPts?: number

  push(chunk: Uint8Array): EncodedPacket[] {
    if (this.pending.length + chunk.length > MAX_MEDIA_BUFFER)
      throw new Error("录像数据超过浏览器解析缓冲上限。")
    this.pending = concatBytes(this.pending, chunk)
    return this.parse(false)
  }

  finish(): EncodedPacket[] {
    const result = this.parse(true)
    this.parseVideo(result, true)
    this.flushVideo(result)
    if (!this.mediaPackets)
      throw new Error("未找到可保存的 H.264 / H.265 录像。")
    return result
  }

  private parse(final: boolean) {
    const result: EncodedPacket[] = []
    while (this.pending.length >= 4) {
      const start = packetStart(this.pending)
      if (start < 0) {
        this.scannedBytes += this.pending.length - 3
        if (!this.mediaPackets && this.scannedBytes > 1024 * 1024)
          throw new Error("设备返回的录像容器不受支持。")
        this.pending = final ? new Uint8Array(0) : this.pending.slice(-3)
        break
      }
      if (start) {
        this.scannedBytes += start
        this.pending = this.pending.slice(start)
      }
      const id = this.pending[3]
      if (id === 0xb9) {
        this.pending = this.pending.slice(4)
        continue
      }
      if (id === 0xba) {
        if (this.pending.length < 14) break
        const length =
          (this.pending[4] & 0xc0) === 0x40 ? 14 + (this.pending[13] & 7) : 12
        if (this.pending.length < length) break
        this.pending = this.pending.slice(length)
        continue
      }
      if (this.pending.length < 6) break
      const declared = u16(this.pending, 4)
      let length = 6 + declared
      if (!declared) {
        const next = packetStart(this.pending, 6)
        if (next < 0 && !final) break
        length = next < 0 ? this.pending.length : next
      }
      if (length > MAX_MEDIA_BUFFER)
        throw new Error("录像数据包超过浏览器缓冲上限。")
      if (this.pending.length < length) break
      const packet = this.pending.subarray(6, length)
      if (id === 0xbc) this.readMap(packet)
      else if ((id >= 0xc0 && id <= 0xef) || id === 0xbd)
        this.readPes(id, packet, result)
      this.pending = this.pending.slice(length)
    }
    if (final && this.pending.length >= 6 && packetStart(this.pending) === 0)
      throw new Error("设备录像下载中断，最后一个数据包不完整。")
    return result
  }

  private readMap(data: Uint8Array) {
    if (data.length < 6) throw new Error("录像流映射不完整。")
    const programInfo = u16(data, 2),
      mapStart = 6 + programInfo
    if (mapStart > data.length) throw new Error("录像流映射无效。")
    const mapEnd = mapStart + u16(data, 4 + programInfo)
    if (mapEnd > data.length) throw new Error("录像流映射无效。")
    for (let at = mapStart; at + 4 <= mapEnd;) {
      this.streamTypes.set(data[at + 1], data[at])
      at += 4 + u16(data, at + 2)
      if (at > mapEnd) throw new Error("录像流映射无效。")
    }
  }

  private unwrap(value: number) {
    const range = 0x200000000
    let result = value
    if (this.timestampReference !== undefined)
      result += Math.round((this.timestampReference - value) / range) * range
    this.timestampReference = Math.max(
      this.timestampReference ?? result,
      result
    )
    return result / 90000
  }

  private readPes(id: number, data: Uint8Array, result: EncodedPacket[]) {
    if (data.length < 3) throw new Error("录像媒体包不完整。")
    let offset = 0,
      presentation: number | undefined,
      decode: number | undefined
    if ((data[0] & 0xc0) === 0x80) {
      offset = 3 + data[2]
      if (offset > data.length) throw new Error("录像媒体包头无效。")
      if (data[1] & 0x80) presentation = this.unwrap(pts(data, 3))
      if ((data[1] & 0xc0) === 0xc0) decode = this.unwrap(pts(data, 8))
    } else {
      while (data[offset] === 255) offset++
      if ((data[offset] & 0xc0) === 0x40) offset += 2
      if ((data[offset] & 0xf0) === 0x20) {
        presentation = this.unwrap(pts(data, offset))
        offset += 5
      } else if ((data[offset] & 0xf0) === 0x30) {
        presentation = this.unwrap(pts(data, offset))
        decode = this.unwrap(pts(data, offset + 5))
        offset += 10
      } else if (data[offset] === 15) offset++
      else throw new Error("录像媒体包头格式不受支持。")
    }
    const payload = data.subarray(offset),
      type = this.streamTypes.get(id)
    const isVideo = (id >= 0xe0 && id <= 0xef) || type === 0x1b || type === 0x24
    if (isVideo) {
      if (presentation !== undefined)
        this.timeMarkers.push({
          offset: this.videoReceived,
          pts: presentation,
          dts: decode,
        })
      if (this.timeMarkers.length > 1024)
        throw new Error("录像视频缺少有效的帧边界。")
      if (this.videoPending.length + payload.length > MAX_MEDIA_BUFFER)
        throw new Error("录像视频帧超过浏览器缓冲上限。")
      this.videoPending = concatBytes(this.videoPending, payload)
      this.videoReceived += payload.length
      this.parseVideo(result, false)
    } else if (type === 0x90 || type === 0x91) {
      if (presentation === undefined || !payload.length) return
      const codec = type === 0x90 ? "alaw" : "ulaw"
      this.firstPts ??= presentation
      result.push({
        kind: "audio",
        codec,
        pts: presentation,
        duration: payload.length / 8000,
        keyframe: true,
        data: payload.slice(),
        audio: { codec, sampleRate: 8000, channels: 1 },
      })
    } else if (
      (id >= 0xc0 && id <= 0xdf) ||
      (id === 0xbd &&
        type !== undefined &&
        UNSUPPORTED_AUDIO_STREAM_TYPES.has(type))
    )
      this.audioUnsupported = true
  }

  private parseVideo(result: EncodedPacket[], final: boolean) {
    const starts: { prefix: number; data: number }[] = []
    for (let i = 0; i + 3 <= this.videoPending.length; i++) {
      if (this.videoPending[i] || this.videoPending[i + 1]) continue
      if (this.videoPending[i + 2] === 1) {
        starts.push({ prefix: i, data: i + 3 })
        i += 2
      } else if (
        this.videoPending[i + 2] === 0 &&
        this.videoPending[i + 3] === 1
      ) {
        starts.push({ prefix: i, data: i + 4 })
        i += 3
      }
    }
    const complete = final ? starts.length : Math.max(0, starts.length - 1)
    for (let i = 0; i < complete; i++) {
      const start = starts[i],
        end = starts[i + 1]?.prefix ?? this.videoPending.length
      const absolute = this.videoPosition + start.prefix
      while (
        this.timeMarkers.length &&
        this.timeMarkers[0].offset <= absolute
      ) {
        const marker = this.timeMarkers.shift()!
        this.nextVideoTime = { pts: marker.pts, dts: marker.dts }
      }
      const nal = this.videoPending.slice(start.data, end)
      if (nal.length) this.readNal(nal, result)
    }
    const consumed = final
      ? this.videoPending.length
      : (starts[complete]?.prefix ?? Math.max(0, this.videoPending.length - 3))
    this.videoPending = this.videoPending.slice(consumed)
    this.videoPosition += consumed
  }

  private readNal(nal: Uint8Array, result: EncodedPacket[]) {
    const type = [...this.streamTypes.values()].find(
      (value) => value === 0x1b || value === 0x24
    )
    const hint: VideoCodec | undefined =
      type === 0x24 ? "hevc" : type === 0x1b ? "h264" : undefined
    const codec = this.video.inspect([nal], hint)?.codec
    if (codec) {
      const boundary = nalBoundary(nal, codec)
      if (this.hasVideoSlice && (boundary.first || boundary.prefix))
        this.flushVideo(result)
      if (boundary.slice && !this.hasVideoSlice) {
        const duration = this.video.config?.frameDuration ?? this.frameDuration
        this.currentVideoTime =
          this.nextVideoTime ??
          (this.lastVideoTime && {
            pts: this.lastVideoTime.pts + duration,
            dts:
              this.lastVideoTime.dts === undefined
                ? undefined
                : this.lastVideoTime.dts + duration,
          })
        this.nextVideoTime = undefined
        this.hasVideoSlice = true
      }
    }
    this.currentNals.push(nal)
    this.currentVideoBytes += nal.length
    if (this.currentVideoBytes > MAX_MEDIA_BUFFER)
      throw new Error("录像视频帧超过浏览器缓冲上限。")
  }

  private flushVideo(result: EncodedPacket[]) {
    const nals = this.currentNals,
      time = this.currentVideoTime
    this.currentNals = []
    this.currentVideoBytes = 0
    this.currentVideoTime = undefined
    this.hasVideoSlice = false
    if (!time || !nals.length) return
    const info = this.video.inspect(nals)
    if (!info?.hasFrame) return
    if (!info.config) {
      if (info.keyframe) throw new Error("录像关键帧缺少完整的视频参数集。")
      return
    }
    if (this.lastVideoTime) {
      const delta =
        (time.dts ?? time.pts) -
        (this.lastVideoTime.dts ?? this.lastVideoTime.pts)
      if (delta > 0.000001 && delta < 0.5) this.frameDuration = delta
    }
    this.firstPts ??= time.pts
    result.push({
      kind: "video",
      codec: info.codec,
      pts: time.pts,
      dts: time.dts,
      duration: this.frameDuration,
      keyframe: info.keyframe,
      data: lengthPrefixed(nals),
      video: info.config,
    })
    this.lastVideoTime = time
    this.mediaPackets++
  }
}
