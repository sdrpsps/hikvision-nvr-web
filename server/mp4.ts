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
  const track = boxes(tracks[0].data),
    mdia = track.find((box) => box.type === "mdia"),
    tkhd = track.find((box) => box.type === "tkhd")
  if (!mdia || !tkhd || tkhd.data[0] > 1) invalid()
  const trackId = u32(tkhd.data, tkhd.data[0] === 1 ? 20 : 12)
  if (!trackId) invalid()
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
  const trex =
    mvex &&
    boxes(mvex.data).find(
      (box) => box.type === "trex" && u32(box.data, 4) === trackId
    )
  const trackDefault = trex ? u32(trex.data, 12) : 0
  const trackDefaultFlags = trex ? u32(trex.data, 20) : undefined
  let min = Infinity,
    max = 0,
    samples = 0,
    decodeMin = Infinity,
    decodeMax = 0,
    firstSampleFlags: number | undefined
  for (const moof of top.filter((box) => box.type === "moof")) {
    for (const traf of boxes(moof.data).filter((box) => box.type === "traf")) {
      const children = boxes(traf.data),
        tfhd = children.find((box) => box.type === "tfhd"),
        tfdt = children.find((box) => box.type === "tfdt")
      if (!tfhd || !tfdt || tfhd.data[0] !== 0 || u32(tfhd.data, 4) !== trackId)
        invalid()
      const f = flags(tfhd.data)
      let at = 8 + (f & 1 ? 8 : 0) + (f & 2 ? 4 : 0)
      const defaultDuration = f & 8 ? u32(tfhd.data, at) : trackDefault
      if (f & 8) at += 4
      if (f & 16) {
        u32(tfhd.data, at)
        at += 4
      }
      const defaultSampleFlags = f & 32 ? u32(tfhd.data, at) : trackDefaultFlags
      if (f & 32) at += 4
      if (at !== tfhd.data.length) invalid()
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
        // ISO BMFF does not allow first_sample_flags and sample_flags together.
        if (tf & 4 && tf & 0x400) invalid()
        if ((samples += count) > 100000 || trun.data[0] > 1) invalid()
        at = 8
        if (tf & 1) {
          u32(trun.data, at)
          at += 4
        }
        const runFirstFlags = tf & 4 ? u32(trun.data, at) : undefined
        if (tf & 4) at += 4
        for (let i = 0; i < count; i++) {
          const duration = tf & 0x100 ? u32(trun.data, at) : defaultDuration
          if (tf & 0x100) at += 4
          if (tf & 0x200) {
            u32(trun.data, at)
            at += 4
          }
          const sampleFlags =
            tf & 0x400
              ? u32(trun.data, at)
              : i === 0
                ? (runFirstFlags ?? defaultSampleFlags)
                : defaultSampleFlags
          if (tf & 0x400) at += 4
          // A zero/absent dependency field is unknown, not proof of a keyframe.
          if (sampleFlags !== undefined && ((sampleFlags >>> 24) & 3) === 3)
            invalid()
          if (decodeMin === Infinity) firstSampleFlags = sampleFlags
          let composition = 0
          if (tf & 0x800) {
            composition = u32(trun.data, at)
            if (trun.data[0] === 1 && composition > 0x7fffffff)
              composition -= 0x100000000
            at += 4
          }
          if (!duration || !Number.isSafeInteger(timestamp + duration))
            invalid()
          decodeMin = Math.min(decodeMin, timestamp)
          decodeMax = Math.max(decodeMax, timestamp + duration)
          min = Math.min(min, timestamp + composition)
          max = Math.max(max, timestamp + composition + duration)
          timestamp += duration
        }
        if (at !== trun.data.length) invalid()
      }
    }
  }
  const durationSeconds = (max - min) / timescale
  const decodeDurationSeconds = (decodeMax - decodeMin) / timescale
  if (
    !samples ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 40 ||
    !Number.isFinite(decodeDurationSeconds) ||
    decodeDurationSeconds <= 0 ||
    decodeDurationSeconds > 40
  )
    invalid()
  return {
    init: buffer.subarray(0, first.start),
    media: buffer.subarray(first.start),
    durationSeconds,
    startSeconds: min / timescale,
    decodeStartSeconds: decodeMin / timescale,
    decodeDurationSeconds,
    sampleCount: samples,
    startsWithKeyframe:
      firstSampleFlags !== undefined &&
      !(firstSampleFlags & 0x10000) &&
      ((firstSampleFlags >>> 24) & 3) === 2,
    codec,
  }
}

export { boxes as mp4Boxes, u32 as mp4U32 }
