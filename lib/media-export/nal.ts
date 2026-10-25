import { concatBytes, type VideoCodec, type VideoConfig } from "./types"
import { Bits, rbsp, h264Dimensions, h265Parameters } from "./nal-parameters"

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
