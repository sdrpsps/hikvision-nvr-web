export function rbsp(nal: Uint8Array, skip: number) {
  const bytes: number[] = []
  for (let i = skip; i < nal.length; i++) {
    if (i >= skip + 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0)
      continue
    bytes.push(nal[i])
  }
  return Uint8Array.from(bytes)
}

export class Bits {
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

export function h264Dimensions(sps: Uint8Array) {
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

export function h265Parameters(sps: Uint8Array) {
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
