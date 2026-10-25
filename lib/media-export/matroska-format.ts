import {
  concatBytes,
  type AudioConfig,
  type EncodedPacket,
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
export function float(value: number) {
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
export function matroskaHeader(
  video: VideoConfig,
  audio: AudioConfig | undefined,
  frameDuration: number | undefined,
  seekable: boolean
) {
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
  const duration = seekable ? element(0x4489, float(0)) : new Uint8Array(0)
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
      videoTrack(video, frameDuration),
      ...(audio ? [audioTrack(audio)] : [])
    )
  )
  const segmentOffset = ebml.length + segment.length
  const durationOffset = ebml.length + segment.length + info.length - 8
  return { header, segmentOffset, durationOffset }
}

export function matroskaCues(cues: { time: number; position: number }[]) {
  return master(
    0x1c53bb6b,
    ...cues.map((cue) =>
      master(
        0xbb,
        uint(0xb3, cue.time),
        master(0xb7, uint(0xf7, 1), uint(0xf1, cue.position))
      )
    )
  )
}

export function matroskaCluster(
  packet: EncodedPacket,
  pts: number,
  clusterTime: number
) {
  const relative = pts - clusterTime
  if (relative < -32768 || relative > 32767)
    throw new Error("媒体解码与显示时间戳相差过大。")
  const prefix = new Uint8Array(4)
  prefix[0] = packet.kind === "video" ? 0x81 : 0x82
  new DataView(prefix.buffer).setInt16(1, relative)
  prefix[3] = packet.keyframe ? 0x80 : 0
  return master(
    0x1f43b675,
    uint(0xe7, clusterTime),
    element(0xa3, concatBytes(prefix, packet.data))
  )
}
