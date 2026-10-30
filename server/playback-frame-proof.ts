import { createHash } from "node:crypto"
import { FragmentedMp4Demuxer } from "../lib/media-export/mp4-demuxer"
import { MAX_MEDIA_BUFFER, type VideoCodec } from "../lib/media-export/types"
import { AppError } from "./errors"
import type { PreviewMedia } from "./remux"

const MAX_INIT_BYTES = 256 * 1024
const MAX_SAMPLE_NALS = 4096

function mismatch(): never {
  throw new AppError(
    "MEDIA_CLOCK_MISMATCH",
    502,
    "录像封装的首帧与设备时间不符，已停止回放。"
  )
}

function firstVclHash(data: Uint8Array, codec: VideoCodec, lengthSize: number) {
  let result: string | undefined
  let count = 0
  for (let offset = 0; offset < data.length;) {
    if (++count > MAX_SAMPLE_NALS || offset + lengthSize > data.length)
      mismatch()
    let length = 0
    for (let index = 0; index < lengthSize; index++)
      length = length * 256 + data[offset + index]
    offset += lengthSize
    if (!length || length > data.length - offset) mismatch()
    const nal = data.subarray(offset, offset + length)
    offset += length
    const headerSize = codec === "h264" ? 1 : 2
    if (nal.length <= headerSize || nal[0] & 0x80) mismatch()
    const type = codec === "h264" ? nal[0] & 31 : (nal[0] >>> 1) & 63
    if (codec === "hevc" && (!(nal[1] & 7) || nal[0] & 1 || nal[1] >>> 3))
      mismatch()
    const vcl = codec === "h264" ? type >= 1 && type <= 5 : type <= 31
    if (
      codec === "h264"
        ? !vcl && ![6, 7, 8, 9, 12, 13].includes(type)
        : !vcl && (type < 32 || type > 40)
    )
      mismatch()
    if (!vcl || result !== undefined) continue
    if (
      (codec === "h264"
        ? type !== 5 || !(nal[0] & 0x60)
        : (type !== 19 && type !== 20) || (nal[1] & 7) !== 1) ||
      !(nal[headerSize] & 0x80)
    )
      mismatch()
    // Annex B includes trailing_zero_8bits which an MP4 converter can remove.
    // Both sides hash the same NAL EBSP, excluding those trailing zero bytes.
    let end = nal.length
    while (end > headerSize && nal[end - 1] === 0) end--
    result = createHash("sha256").update(nal.subarray(0, end)).digest("hex")
  }
  if (result === undefined) mismatch()
  return result
}

type FrameMedia = Pick<PreviewMedia, "init" | "media" | "codec">

// Internal proof metadata only: never include this hash in a response or log.
// Structural parsing does not decode video or produce pixels.
export function firstPlaybackFrameHash(media: FrameMedia): string {
  try {
    if (
      (media.codec !== "h264" && media.codec !== "hevc") ||
      media.init.length > MAX_INIT_BYTES ||
      media.media.length > MAX_MEDIA_BUFFER
    )
      mismatch()
    const demuxer = new FragmentedMp4Demuxer()
    if (demuxer.push(media.init).length || !demuxer.video) mismatch()
    const config = demuxer.video
    const lengthOffset = config.codec === "h264" ? 4 : 21
    const minimumLength = config.codec === "h264" ? 7 : 23
    if (
      config.codec !== media.codec ||
      config.codecPrivate.length < minimumLength ||
      config.codecPrivate[0] !== 1
    )
      mismatch()
    const packets = demuxer.push(media.media)
    demuxer.finish()
    const first = packets[0]
    if (
      !first ||
      first.kind !== "video" ||
      first.codec !== media.codec ||
      !first.keyframe
    )
      mismatch()
    const lengthSize = (config.codecPrivate[lengthOffset] & 3) + 1
    return firstVclHash(first.data, media.codec, lengthSize)
  } catch {
    mismatch()
  }
}

export function confirmPlaybackFrame(
  media: FrameMedia,
  expectedHash: string
): void {
  if (
    !/^[0-9a-f]{64}$/.test(expectedHash) ||
    firstPlaybackFrameHash(media) !== expectedHash
  )
    mismatch()
}
