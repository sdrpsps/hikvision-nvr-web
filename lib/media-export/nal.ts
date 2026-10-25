import { concatBytes, type VideoCodec, type VideoConfig } from "./types"

export function annexBNals(bytes: Uint8Array): Uint8Array[] {
  const starts: { start: number; data: number }[] = []
  for (let i = 0; i + 3 <= bytes.length; i++) {
    if (bytes[i] || bytes[i + 1]) continue
    if (bytes[i + 2] === 1) {
      starts.push({ start: i, data: i + 3 })
      i += 2
    } else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      starts.push({ start: i, data: i + 4 })
      i += 3
    }
  }
  return starts
    .map((entry, index) =>
      bytes.subarray(entry.data, starts[index + 1]?.start ?? bytes.length)
    )
    .filter((nal) => nal.length)
}

export function lengthPrefixed(nals: Uint8Array[]) {
  return concatBytes(
    ...nals.map((nal) => {
      const value = new Uint8Array(nal.length + 4)
      new DataView(value.buffer).setUint32(0, nal.length)
      value.set(nal, 4)
      return value
    })
  )
}

export function splitAccessUnits(nals: Uint8Array[], codec: VideoCodec) {
  const frames: Uint8Array[][] = []
  let current: Uint8Array[] = [],
    hasSlice = false
  for (const nal of nals) {
    const type = codec === "hevc" ? (nal[0] >>> 1) & 63 : nal[0] & 31
    const slice = codec === "hevc" ? type <= 31 : [1, 5].includes(type)
    const first =
      slice &&
      (codec === "hevc" ? !!(nal[2] & 0x80) : new Bits(rbsp(nal, 1)).ue() === 0)
    const prefix =
      codec === "hevc"
        ? [32, 33, 34, 35, 39].includes(type)
        : [6, 7, 8, 9].includes(type)
    if (hasSlice && (first || prefix)) {
      frames.push(current)
      current = []
      hasSlice = false
    }
    current.push(nal)
    hasSlice ||= slice
  }
  if (current.length) frames.push(current)
  return frames
}

export function nalBoundary(nal: Uint8Array, codec: VideoCodec) {
  const type = codec === "hevc" ? (nal[0] >>> 1) & 63 : nal[0] & 31
  const slice = codec === "hevc" ? type <= 31 : [1, 5].includes(type)
  return {
    slice,
    first:
      slice &&
      (codec === "hevc"
        ? !!(nal[2] & 0x80)
        : new Bits(rbsp(nal, 1)).ue() === 0),
    prefix:
      codec === "hevc"
        ? [32, 33, 34, 35, 39].includes(type)
        : [6, 7, 8, 9].includes(type),
  }
}

function rbsp(nal: Uint8Array, skip: number) {
  const bytes: number[] = []
  for (let i = skip; i < nal.length; i++) {
    if (i >= skip + 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0)
      continue
    bytes.push(nal[i])
  }
  return Uint8Array.from(bytes)
}

class Bits {
  position = 0
  constructor(readonly bytes: Uint8Array) {}
  read(count: number) {
    if (count > 32 || this.position + count > this.bytes.length * 8)
      throw new Error("视频参数集不完整。")
    let value = 0
    for (let i = 0; i < count; i++, this.position++)
      value =
        value * 2 +
        ((this.bytes[this.position >>> 3] >>> (7 - (this.position & 7))) & 1)
    return value
  }
  skip(count: number) {
    if (this.position + count > this.bytes.length * 8)
      throw new Error("视频参数集不完整。")
    this.position += count
  }
  ue() {
    let zeros = 0
    while (!this.read(1)) {
      if (++zeros > 30) throw new Error("视频参数集无效。")
    }
    return 2 ** zeros - 1 + this.read(zeros)
  }
  se() {
    const value = this.ue()
    return value & 1 ? (value + 1) / 2 : -value / 2
  }
}

function h264Dimensions(sps: Uint8Array) {
  const b = new Bits(rbsp(sps, 1))
  const profile = b.read(8)
  b.skip(16)
  b.ue()
  let chroma = 1
  if (
    [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(
      profile
    )
  ) {
    chroma = b.ue()
    if (chroma === 3) b.read(1)
    b.ue()
    b.ue()
    b.read(1)
    if (b.read(1)) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!b.read(1)) continue
        let last = 8,
          next = 8
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + b.se() + 256) % 256
          last = next || last
        }
      }
    }
  }
  b.ue()
  const order = b.ue()
  if (order === 0) b.ue()
  else if (order === 1) {
    b.read(1)
    b.se()
    b.se()
    const count = b.ue()
    if (count > 256) throw new Error("视频参数集无效。")
    for (let i = 0; i < count; i++) b.se()
  }
  b.ue()
  b.read(1)
  let width = (b.ue() + 1) * 16
  const heightMap = b.ue() + 1
  const frameOnly = b.read(1)
  let height = heightMap * 16 * (2 - frameOnly)
  if (!frameOnly) b.read(1)
  b.read(1)
  if (b.read(1)) {
    const left = b.ue(),
      right = b.ue(),
      top = b.ue(),
      bottom = b.ue()
    const subWidth = chroma === 1 || chroma === 2 ? 2 : 1
    const subHeight = chroma === 1 ? 2 : 1
    width -= (left + right) * subWidth
    height -= (top + bottom) * subHeight * (2 - frameOnly)
  }
  let frameDuration: number | undefined
  if (b.read(1)) {
    if (b.read(1) && b.read(8) === 255) b.skip(32)
    if (b.read(1)) b.read(1)
    if (b.read(1)) {
      b.skip(4)
      if (b.read(1)) b.skip(24)
    }
    if (b.read(1)) {
      b.ue()
      b.ue()
    }
    if (b.read(1)) {
      const units = b.read(32),
        scale = b.read(32)
      b.read(1)
      if (units && scale) frameDuration = (2 * units) / scale
    }
  }
  return { width, height, frameDuration }
}

function h265Parameters(sps: Uint8Array) {
  const raw = rbsp(sps, 2),
    b = new Bits(raw)
  b.read(4)
  const layers = b.read(3),
    nested = b.read(1)
  const profile = raw.slice(1, 13)
  b.skip(96)
  const profiles: number[] = [],
    levels: number[] = []
  for (let i = 0; i < layers; i++) {
    profiles.push(b.read(1))
    levels.push(b.read(1))
  }
  if (layers) b.skip((8 - layers) * 2)
  for (let i = 0; i < layers; i++) {
    if (profiles[i]) b.skip(88)
    if (levels[i]) b.skip(8)
  }
  b.ue()
  const chroma = b.ue()
  if (chroma === 3) b.read(1)
  let width = b.ue(),
    height = b.ue()
  if (b.read(1)) {
    const left = b.ue(),
      right = b.ue(),
      top = b.ue(),
      bottom = b.ue()
    width -= (left + right) * (chroma === 1 || chroma === 2 ? 2 : 1)
    height -= (top + bottom) * (chroma === 1 ? 2 : 1)
  }
  const luma = b.ue(),
    chromaDepth = b.ue()
  return { width, height, profile, layers, nested, chroma, luma, chromaDepth }
}

export class AnnexBVideo {
  codec?: VideoCodec
  private parameters = new Map<number, Uint8Array>()
  config?: VideoConfig
  inspect(nals: Uint8Array[], hint?: VideoCodec) {
    if (hint) this.codec = hint
    if (!this.codec) {
      if (
        nals.some(
          (nal) => [32, 33, 34].includes((nal[0] >>> 1) & 63) && nal[1] === 1
        )
      )
        this.codec = "hevc"
      else if (nals.some((nal) => [7, 8].includes(nal[0] & 31)))
        this.codec = "h264"
    }
    if (!this.codec) return
    for (const nal of nals) {
      const type = this.codec === "hevc" ? (nal[0] >>> 1) & 63 : nal[0] & 31
      if ((this.codec === "hevc" ? [32, 33, 34] : [7, 8]).includes(type)) {
        const previous = this.parameters.get(type)
        if (
          !previous ||
          previous.length !== nal.length ||
          previous.some((value, i) => value !== nal[i])
        ) {
          this.parameters.set(type, nal.slice())
          this.config = undefined
        }
      }
    }
    if (!this.config) this.config = this.buildConfig()
    return {
      codec: this.codec,
      keyframe: nals.some((nal) =>
        this.codec === "hevc"
          ? [16, 17, 18, 19, 20, 21].includes((nal[0] >>> 1) & 63)
          : (nal[0] & 31) === 5
      ),
      hasFrame: nals.some((nal) =>
        this.codec === "hevc"
          ? ((nal[0] >>> 1) & 63) <= 31
          : [1, 5].includes(nal[0] & 31)
      ),
      config: this.config,
    }
  }
  private buildConfig(): VideoConfig | undefined {
    if (this.codec === "h264") {
      const sps = this.parameters.get(7),
        pps = this.parameters.get(8)
      if (!sps || !pps) return
      const header = Uint8Array.from([
        1,
        sps[1],
        sps[2],
        sps[3],
        255,
        225,
        sps.length >>> 8,
        sps.length & 255,
      ])
      const codecPrivate = concatBytes(
        header,
        sps,
        Uint8Array.from([1, pps.length >>> 8, pps.length & 255]),
        pps
      )
      return { codec: "h264", ...h264Dimensions(sps), codecPrivate }
    }
    const vps = this.parameters.get(32),
      sps = this.parameters.get(33),
      pps = this.parameters.get(34)
    if (!vps || !sps || !pps) return
    const info = h265Parameters(sps)
    const header = new Uint8Array(23)
    header[0] = 1
    header.set(info.profile, 1)
    header.set(
      [240, 0, 252, 252 | info.chroma, 248 | info.luma, 248 | info.chromaDepth],
      13
    )
    header[21] = ((info.layers + 1) << 3) | (info.nested << 2) | 3
    header[22] = 3
    const arrays = [vps, sps, pps].map((nal, i) =>
      concatBytes(
        Uint8Array.from([
          128 | (32 + i),
          0,
          1,
          nal.length >>> 8,
          nal.length & 255,
        ]),
        nal
      )
    )
    return {
      codec: "hevc",
      width: info.width,
      height: info.height,
      codecPrivate: concatBytes(header, ...arrays),
    }
  }
}
