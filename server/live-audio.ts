import { mp4Boxes as boxes, mp4U32 as u32 } from "./mp4"
import { AppError } from "./errors"

// Parse copied G.711 packets and timestamps only. Decoding happens in the browser.
export function copiedAudio(init: Buffer, fragment: Buffer) {
  const bad = () =>
    new AppError(
      "LIVE_AUDIO_UNSUPPORTED",
      502,
      "此通道音频暂不支持本机播放，视频可继续预览。"
    )
  const moov = boxes(init).find((box) => box.type === "moov")
  const trak = moov && boxes(moov.data).filter((box) => box.type === "trak")
  if (!trak || trak.length !== 1) throw bad()
  const mdia = boxes(trak[0].data).find((box) => box.type === "mdia")
  const mdhd = mdia && boxes(mdia.data).find((box) => box.type === "mdhd")
  const minf = mdia && boxes(mdia.data).find((box) => box.type === "minf")
  const stbl = minf && boxes(minf.data).find((box) => box.type === "stbl")
  const stsd = stbl && boxes(stbl.data).find((box) => box.type === "stsd")
  if (!mdhd || !stsd || u32(stsd.data, 4) !== 1) throw bad()
  const entries = boxes(stsd.data.subarray(8)),
    entry = entries[0]
  if (
    entries.length !== 1 ||
    !["alaw", "ulaw"].includes(entry.type) ||
    entry.data.length < 28 ||
    mdhd.data[0] > 1
  )
    throw bad()
  const sampleRate = u32(mdhd.data, mdhd.data[0] === 1 ? 20 : 12)
  const channels = entry.data.readUInt16BE(16)
  if (
    ![8000, 16000, 32000, 48000].includes(sampleRate) ||
    channels < 1 ||
    channels > 2
  )
    throw bad()
  const top = boxes(fragment),
    moof = top.find((box) => box.type === "moof"),
    mdat = top.find((box) => box.type === "mdat")
  const trafs = moof && boxes(moof.data).filter((box) => box.type === "traf")
  const tfdt =
    trafs?.length === 1 &&
    boxes(trafs[0].data).find((box) => box.type === "tfdt")
  if (
    !tfdt ||
    !mdat ||
    tfdt.data.length < 8 ||
    tfdt.data[0] > 1 ||
    !mdat.data.length ||
    mdat.data.length % channels
  )
    throw bad()
  let timestamp = u32(tfdt.data, 4)
  if (tfdt.data[0] === 1) {
    if (tfdt.data.length < 12) throw bad()
    const value = tfdt.data.readBigUInt64BE(4)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw bad()
    timestamp = Number(value)
  }
  return {
    codec: entry.type as "alaw" | "ulaw",
    sampleRate,
    channels,
    startSeconds: timestamp / sampleRate,
    data: Buffer.from(mdat.data),
  }
}

// Both live preview and playback receive the same copied audio pipe. Keep
// incremental container state here; callers own delivery, retention and errors.
export class CopiedAudioParser {
  private pending = Buffer.alloc(0)
  private init = Buffer.alloc(0)
  private fragment = Buffer.alloc(0)

  constructor(private options: { skipEmptyMedia?: boolean } = {}) {}

  *push(chunk: Buffer): Generator<ReturnType<typeof copiedAudio>> {
    if (this.pending.length + chunk.length > 256 * 1024) throw new Error()
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(0)
      if (size < 8 || size > 256 * 1024) throw new Error()
      if (this.pending.length < size) break
      const box = this.pending.subarray(0, size)
      const type = box.toString("ascii", 4, 8)
      this.pending = this.pending.subarray(size)
      if (type === "ftyp" || type === "moov") {
        if (this.init.length + size > 64 * 1024) throw new Error()
        this.init = Buffer.concat([this.init, box])
      } else if (type === "moof") this.fragment = box
      else if (type === "mdat") {
        if (!(this.options.skipEmptyMedia && size === 8))
          yield copiedAudio(this.init, Buffer.concat([this.fragment, box]))
        this.fragment = Buffer.alloc(0)
      }
    }
  }

  reset() {
    this.pending = this.init = this.fragment = Buffer.alloc(0)
  }
}
