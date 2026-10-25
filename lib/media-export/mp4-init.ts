import { u16, u32, u64, type AudioConfig, type VideoConfig } from "./types"

type Box = {
  type: string
  start: number
  end: number
  header: number
  data: Uint8Array
}
export function boxes(bytes: Uint8Array): Box[] {
  const result: Box[] = []
  for (let at = 0; at < bytes.length;) {
    if (bytes.length - at < 8) throw new Error("MP4 媒体结构不完整。")
    let size = u32(bytes, at),
      header = 8
    if (size === 1) {
      size = u64(bytes, at + 8)
      header = 16
    }
    if (size === 0) size = bytes.length - at
    if (size < header || at + size > bytes.length)
      throw new Error("MP4 媒体结构不完整。")
    result.push({
      type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      start: at,
      end: at + size,
      header,
      data: bytes.subarray(at + header, at + size),
    })
    at += size
  }
  return result
}
function child(bytes: Uint8Array, type: string) {
  return boxes(bytes).find((box) => box.type === type)
}
export function readMp4Init(data: Uint8Array) {
  let video: VideoConfig | undefined
  let audio: AudioConfig | undefined
  let defaultDuration: number | undefined
  let defaultSize: number | undefined
  let defaultFlags: number | undefined
  const tracks = boxes(data).filter((box) => box.type === "trak")
  if (tracks.length !== 1) throw new Error("此媒体通道的轨道结构不受支持。")
  const mdia = child(tracks[0].data, "mdia"),
    tkhd = child(tracks[0].data, "tkhd")
  if (!mdia || !tkhd) throw new Error("媒体缺少轨道参数。")
  const trackId = u32(tkhd.data, tkhd.data[0] === 1 ? 20 : 12)
  const mdhd = child(mdia.data, "mdhd"),
    minf = child(mdia.data, "minf")
  const stbl = minf && child(minf.data, "stbl"),
    stsd = stbl && child(stbl.data, "stsd")
  if (!mdhd || !stsd || u32(stsd.data, 4) !== 1)
    throw new Error("媒体缺少编码参数。")
  const timescale = u32(mdhd.data, mdhd.data[0] === 1 ? 20 : 12)
  if (!timescale) throw new Error("媒体时间刻度无效。")
  const entries = boxes(stsd.data.subarray(8)),
    entry = entries[0]
  if (entries.length !== 1) throw new Error("媒体编码参数不受支持。")
  if (["avc1", "avc3", "hvc1", "hev1"].includes(entry.type)) {
    if (entry.data.length < 78) throw new Error("视频编码参数不完整。")
    const codec = entry.type.startsWith("avc") ? "h264" : "hevc"
    const config = child(
      entry.data.subarray(78),
      codec === "h264" ? "avcC" : "hvcC"
    )
    if (!config) throw new Error("视频缺少解码参数集。")
    video = {
      codec,
      width: u16(entry.data, 24),
      height: u16(entry.data, 26),
      codecPrivate: config.data.slice(),
    }
    audio = undefined
  } else if (["alaw", "ulaw"].includes(entry.type)) {
    audio = {
      codec: entry.type as AudioConfig["codec"],
      channels: u16(entry.data, 16),
      sampleRate: u32(entry.data, 24) / 65536,
    }
    if (!audio.channels || !audio.sampleRate)
      throw new Error("音频编码参数无效。")
    video = undefined
  } else throw new Error("保存暂不支持此音视频编码。")
  const mvex = child(data, "mvex")
  const trex =
    mvex &&
    boxes(mvex.data).find(
      (box) => box.type === "trex" && u32(box.data, 4) === trackId
    )
  if (trex) {
    defaultDuration = u32(trex.data, 12)
    defaultSize = u32(trex.data, 16)
    defaultFlags = u32(trex.data, 20)
  }
  return {
    trackId,
    timescale,
    video,
    audio,
    defaultDuration,
    defaultSize,
    defaultFlags,
  }
}
