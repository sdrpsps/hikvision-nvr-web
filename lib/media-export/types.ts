export type VideoCodec = "h264" | "hevc"
export type AudioCodec = "alaw" | "ulaw"

export type VideoConfig = {
  codec: VideoCodec
  width: number
  height: number
  codecPrivate: Uint8Array
  frameDuration?: number
}

export type AudioConfig = {
  codec: AudioCodec
  sampleRate: number
  channels: number
}

export type EncodedPacket = {
  kind: "video" | "audio"
  codec: VideoCodec | AudioCodec
  pts: number
  dts?: number
  duration?: number
  keyframe: boolean
  data: Uint8Array
  video?: VideoConfig
  audio?: AudioConfig
}

export type ByteWriter = {
  write(data: Uint8Array): Promise<void>
  seek?(position: number): Promise<void>
}

export type MuxerStats = {
  bytesWritten: number
  videoPackets: number
  audioPackets: number
  startPts?: number
  endPts?: number
  durationSeconds: number
}

export const MAX_MEDIA_BUFFER = 16 * 1024 * 1024

export function concatBytes(...values: Uint8Array[]) {
  const result = new Uint8Array(
    values.reduce((n, value) => n + value.length, 0)
  )
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.length
  }
  return result
}

export function u16(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > bytes.length)
    throw new Error("媒体结构不完整。")
  return bytes[offset] * 256 + bytes[offset + 1]
}

export function u32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length)
    throw new Error("媒体结构不完整。")
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 256 +
    bytes[offset + 3]
  )
}

export function u64(bytes: Uint8Array, offset: number) {
  const value = u32(bytes, offset) * 0x100000000 + u32(bytes, offset + 4)
  if (!Number.isSafeInteger(value)) throw new Error("媒体时间戳超出支持范围。")
  return value
}
