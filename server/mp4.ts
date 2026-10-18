import { AppError } from "./errors"

function invalid(): never {
  throw new AppError(
    "MEDIA_INVALID_CONTAINER",
    502,
    "录像封装不完整或不受支持。"
  )
}
type Box = { type: string; start: number; end: number; data: Buffer }
function boxes(data: Buffer): Box[] {
  const result: Box[] = []
  for (let offset = 0; offset < data.length;) {
    if (data.length - offset < 8 || result.length >= 16384) invalid()
    let size = data.readUInt32BE(offset),
      header = 8
    if (size === 1) {
      if (data.length - offset < 16) invalid()
      const value = data.readBigUInt64BE(offset + 8)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
      size = Number(value)
      header = 16
    }
    if (size === 0) size = data.length - offset
    if (size < header || offset + size > data.length) invalid()
    result.push({
      type: data.toString("ascii", offset + 4, offset + 8),
      start: offset,
      end: offset + size,
      data: data.subarray(offset + header, offset + size),
    })
    offset += size
  }
  return result
}
function u32(data: Buffer, offset: number) {
  if (offset + 4 > data.length) invalid()
  return data.readUInt32BE(offset)
}
function flags(data: Buffer) {
  return u32(data, 0) & 0xffffff
}

// Structural parsing only: encoded video is never decoded into pixels here.
export function splitFragmentedMp4(buffer: Buffer) {
  const top = boxes(buffer),
    moov = top.find((box) => box.type === "moov"),
    first = top.find((box) => box.type === "moof")
  if (
    !moov ||
    !first ||
    !top.some((box) => box.type === "ftyp") ||
    moov.end > first.start ||
    !top.some((box) => box.type === "mdat")
  )
    invalid()
  const tracks = boxes(moov.data).filter((box) => box.type === "trak")
  if (tracks.length !== 1) invalid()
  const mdia = boxes(tracks[0].data).find((box) => box.type === "mdia")
  if (!mdia) invalid()
  const minf = boxes(mdia.data).find((box) => box.type === "minf")
  const stbl = minf && boxes(minf.data).find((box) => box.type === "stbl")
  const stsd = stbl && boxes(stbl.data).find((box) => box.type === "stsd")
  if (!stsd || u32(stsd.data, 4) !== 1) invalid()
  const entries = boxes(stsd.data.subarray(8))
  if (entries.length !== 1) invalid()
  const sampleEntry = entries[0].type
  const codec =
    sampleEntry === "avc1" || sampleEntry === "avc3"
      ? ("h264" as const)
      : sampleEntry === "hvc1" || sampleEntry === "hev1"
        ? ("hevc" as const)
        : undefined
  if (!codec)
    throw new AppError(
      "MEDIA_UNSUPPORTED_CODEC",
      502,
      "当前预览仅支持 H.264 和 H.265 视频，不执行服务端转码。"
    )
  const mdhd = boxes(mdia.data).find((box) => box.type === "mdhd")
  if (!mdhd || mdhd.data[0] > 1) invalid()
  const timescale = u32(mdhd.data, mdhd.data[0] === 1 ? 20 : 12)
  if (!timescale) invalid()
  const mvex = boxes(moov.data).find((box) => box.type === "mvex")
  const trex = mvex && boxes(mvex.data).find((box) => box.type === "trex")
  const trackDefault = trex ? u32(trex.data, 12) : 0
  let min = Infinity,
    max = 0,
    samples = 0
  for (const moof of top.filter((box) => box.type === "moof")) {
    for (const traf of boxes(moof.data).filter((box) => box.type === "traf")) {
      const children = boxes(traf.data),
        tfhd = children.find((box) => box.type === "tfhd"),
        tfdt = children.find((box) => box.type === "tfdt")
      if (!tfhd || !tfdt) invalid()
      const f = flags(tfhd.data)
      let at = 8 + (f & 1 ? 8 : 0) + (f & 2 ? 4 : 0)
      const defaultDuration = f & 8 ? u32(tfhd.data, at) : trackDefault
      if (tfdt.data[0] > 1) invalid()
      let timestamp: number
      if (tfdt.data[0] === 1) {
        if (tfdt.data.length < 12) invalid()
        const value = tfdt.data.readBigUInt64BE(4)
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
        timestamp = Number(value)
      } else timestamp = u32(tfdt.data, 4)
      for (const trun of children.filter((box) => box.type === "trun")) {
        const tf = flags(trun.data),
          count = u32(trun.data, 4)
        if ((samples += count) > 100000 || trun.data[0] > 1) invalid()
        at = 8 + (tf & 1 ? 4 : 0) + (tf & 4 ? 4 : 0)
        for (let i = 0; i < count; i++) {
          const duration = tf & 0x100 ? u32(trun.data, at) : defaultDuration
          if (tf & 0x100) at += 4
          if (tf & 0x200) {
            u32(trun.data, at)
            at += 4
          }
          if (tf & 0x400) {
            u32(trun.data, at)
            at += 4
          }
          let composition = 0
          if (tf & 0x800) {
            composition = u32(trun.data, at)
            if (trun.data[0] === 1 && composition > 0x7fffffff)
              composition -= 0x100000000
            at += 4
          }
          if (!duration) invalid()
          min = Math.min(min, timestamp + composition)
          max = Math.max(max, timestamp + composition + duration)
          timestamp += duration
        }
      }
    }
  }
  const durationSeconds = (max - min) / timescale
  if (
    !samples ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 40
  )
    invalid()
  return {
    init: buffer.subarray(0, first.start),
    media: buffer.subarray(first.start),
    durationSeconds,
    codec,
  }
}
