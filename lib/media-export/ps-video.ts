import { AnnexBVideo, lengthPrefixed, nalBoundary } from "./nal"
import {
  concatBytes,
  MAX_MEDIA_BUFFER,
  type EncodedPacket,
  type VideoCodec,
} from "./types"

// Assemble access units across PES boundaries without retaining whole recordings.
export class PsVideoAssembler {
  private video = new AnnexBVideo()
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
  private frameDuration = 0.04

  constructor(
    private codecHint: () => VideoCodec | undefined,
    private onPacket: (pts: number) => void
  ) {}

  push(
    payload: Uint8Array,
    presentation: number | undefined,
    decode: number | undefined,
    result: EncodedPacket[]
  ) {
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
  }

  finish(result: EncodedPacket[]) {
    this.parseVideo(result, true)
    this.flushVideo(result)
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
    const hint = this.codecHint()
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
    this.onPacket(time.pts)
  }
}
