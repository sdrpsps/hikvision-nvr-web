import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { FragmentedMp4Demuxer } from "../lib/media-export/mp4-demuxer"
import { annexBNals } from "../lib/media-export/nal"
import { MAX_MEDIA_BUFFER, type VideoCodec } from "../lib/media-export/types"
import { AppError } from "../server/errors"
import { HikPsClock } from "../server/hik-ps-clock"
import { splitFragmentedMp4 } from "../server/mp4"
import {
  confirmPlaybackFrame,
  firstPlaybackFrameHash,
} from "../server/playback-frame-proof"

function words(...values: number[]) {
  const data = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => data.writeUInt32BE(value, index * 4))
  return data
}

function box(type: string, ...parts: Uint8Array[]) {
  const data = Buffer.concat(parts)
  return Buffer.concat([words(data.length + 8), Buffer.from(type), data])
}

function fullBox(type: string, flags: number, ...parts: Uint8Array[]) {
  return box(type, words(flags), ...parts)
}

function hash(nal: Uint8Array) {
  let end = nal.length
  while (end && nal[end - 1] === 0) end--
  return createHash("sha256").update(nal.subarray(0, end)).digest("hex")
}

function inputClock(payload: Uint8Array, codec: VideoCodec) {
  const packet = (id: number, data: Uint8Array) => {
    const head = Buffer.from([0, 0, 1, id, 0, 0])
    head.writeUInt16BE(data.length, 4)
    return Buffer.concat([head, data])
  }
  const hk = Buffer.concat([
    Buffer.from([0x40, 9, 0x48, 0x4b, 1, 0, 26]),
    words(
      10 * 2 ** 28 + 29 * 2 ** 23 + 10 * 2 ** 18 + 2 * 2 ** 12 + 3 * 2 ** 6
    ),
  ])
  const map = packet(
    0xbc,
    Buffer.concat([
      Buffer.from([0xe0, 0xff, 0, hk.length]),
      hk,
      Buffer.from([0, 4, codec === "h264" ? 0x1b : 0x24, 0xe0, 0, 0]),
      Buffer.alloc(4),
    ])
  )
  const video = packet(
    0xe0,
    Buffer.concat([
      Buffer.from([0x80, 0x80, 5, 0x21, 0, 1, 0, 1]),
      payload,
      Buffer.from([0, 0, 1]),
    ])
  )
  const clock = new HikPsClock("UTC", { requireRandomAccess: true })
  const bytes = Buffer.concat([
    Buffer.from([0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0, 0, 3, 0xf8]),
    map,
    video,
  ])
  for (let offset = 0; offset < bytes.length; offset += 157)
    clock.push(bytes.subarray(offset, offset + 157))
  return clock
}

const idr = {
  h264: Buffer.from([0x65, 0x80, 0x12, 0x34]),
  hevc: Buffer.from([0x26, 0x01, 0x80, 0x12, 0x34]),
}
const nonkey = {
  h264: Buffer.from([0x41, 0x80, 0x12, 0x34]),
  hevc: Buffer.from([0x02, 0x01, 0x80, 0x12, 0x34]),
}
const prefixNal = {
  h264: Buffer.from([0x06, 0x80]),
  hevc: Buffer.from([0x4e, 0x01, 0x80]),
}

function sampleData(nals: Uint8Array[], lengthSize: number) {
  return Buffer.concat(
    nals.flatMap((nal) => {
      const prefix = Buffer.alloc(lengthSize)
      prefix.writeUIntBE(nal.length, 0, lengthSize)
      return [prefix, nal]
    })
  )
}

// Tiny structural samples exercise boundary handling. The real encoded fixtures
// below separately prove that Annex B and MP4 stream-copy hashes agree.
function mediaFixture({
  codec = "h264",
  nals = [idr[codec]],
  lengthSize = 4,
  data = sampleData(nals, lengthSize),
  secondSample,
  privateData,
  keyframe = true,
}: {
  codec?: VideoCodec
  nals?: Uint8Array[]
  lengthSize?: number
  data?: Uint8Array
  secondSample?: Uint8Array
  privateData?: Uint8Array
  keyframe?: boolean
} = {}) {
  const config = privateData
    ? Buffer.from(privateData)
    : Buffer.alloc(codec === "h264" ? 7 : 23)
  if (!privateData) {
    config[0] = 1
    config[codec === "h264" ? 4 : 21] = 0xfc | (lengthSize - 1)
  }
  const entry = Buffer.alloc(78)
  entry.writeUInt16BE(160, 24)
  entry.writeUInt16BE(90, 26)
  const init = Buffer.concat([
    box("ftyp", Buffer.from("isom"), words(0)),
    box(
      "moov",
      box(
        "trak",
        fullBox("tkhd", 0, words(0, 0, 1)),
        box(
          "mdia",
          fullBox("mdhd", 0, words(0, 0, 90000, 0)),
          box(
            "minf",
            box(
              "stbl",
              fullBox(
                "stsd",
                0,
                words(1),
                box(
                  codec === "h264" ? "avc1" : "hvc1",
                  entry,
                  box(codec === "h264" ? "avcC" : "hvcC", config)
                )
              )
            )
          )
        )
      ),
      box(
        "mvex",
        fullBox(
          "trex",
          0,
          words(1, 1, 3600, 0, keyframe ? 0x02000000 : 0x01010000)
        )
      )
    ),
  ])
  const samples = secondSample ? [data, secondSample] : [data]
  const fragment = (offset: number) =>
    box(
      "moof",
      fullBox("mfhd", 0, words(1)),
      box(
        "traf",
        fullBox("tfhd", 0x020000, words(1)),
        fullBox("tfdt", 0, words(0)),
        fullBox(
          "trun",
          0x201,
          words(
            samples.length,
            offset,
            ...samples.map((sample) => sample.length)
          )
        )
      )
    )
  const moof = fragment(fragment(0).length + 8)
  return splitFragmentedMp4(
    Buffer.concat([init, moof, box("mdat", ...samples)])
  )
}

function expectMismatch(
  media: Parameters<typeof confirmPlaybackFrame>[0],
  expected = hash(idr.h264)
) {
  expect(() => confirmPlaybackFrame(media, expected)).toThrow(
    expect.objectContaining({
      code: "MEDIA_CLOCK_MISMATCH",
      status: 502,
      message: "录像封装的首帧与设备时间不符，已停止回放。",
    })
  )
}

describe("private playback first-frame proof", () => {
  for (const codec of ["h264", "hevc"] as const) {
    for (const lengthSize of [1, 2, 3, 4])
      it(`confirms ${codec} with a ${lengthSize}-byte NAL prefix`, () => {
        confirmPlaybackFrame(
          mediaFixture({
            codec,
            lengthSize,
            nals: [prefixNal[codec], idr[codec]],
          }),
          hash(idr[codec])
        )
      })

    it(`agrees with the encoded ${codec} fixture converted to Annex B`, () => {
      const name =
        codec === "h264"
          ? "synthetic-preview.mp4"
          : "synthetic-preview-hevc.mp4"
      const path = fileURLToPath(
        new URL(`../fixtures/${name}`, import.meta.url)
      )
      const converted = spawnSync(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          path,
          "-map",
          "0:v:0",
          "-c:v",
          "copy",
          "-an",
          "-bsf:v",
          codec === "h264" ? "h264_mp4toannexb" : "hevc_mp4toannexb",
          "-f",
          codec === "h264" ? "h264" : "hevc",
          "pipe:1",
        ],
        { maxBuffer: 1024 * 1024, timeout: 5000 }
      )
      if (converted.error || converted.status !== 0)
        throw new Error("Synthetic Annex B conversion failed")
      const first = annexBNals(converted.stdout).find((nal) =>
        codec === "h264" ? (nal[0] & 31) <= 5 : ((nal[0] >>> 1) & 63) <= 31
      )
      if (!first) throw new Error("Synthetic fixture has no VCL NAL")
      const clock = inputClock(converted.stdout, codec)
      expect(clock.startAt).toBe("2026-10-29T10:02:03.000Z")
      expect(clock.error).toBeUndefined()
      expect(clock.firstVideoHash).toBe(hash(first))
      const media = splitFragmentedMp4(readFileSync(path))
      confirmPlaybackFrame(media, clock.firstVideoHash!)
      expect(firstPlaybackFrameHash(media)).toBe(clock.firstVideoHash)
    })

    it(`never skips the first ${codec} sample to match a later IDR`, () => {
      const later = Buffer.from(idr[codec])
      later[later.length - 1] ^= 0x10
      const media = mediaFixture({
        codec,
        secondSample: sampleData([later], 4),
      })
      confirmPlaybackFrame(media, hash(idr[codec]))
      expectMismatch(media, hash(later))
    })

    it(`rejects a leading ${codec} non-key VCL even when an IDR follows`, () => {
      expectMismatch(
        mediaFixture({ codec, nals: [nonkey[codec], idr[codec]] }),
        hash(idr[codec])
      )
    })

    it(`normalizes only ${codec} trailing NAL zero bytes`, () => {
      confirmPlaybackFrame(
        mediaFixture({
          codec,
          nals: [Buffer.concat([idr[codec], Buffer.alloc(7)])],
        }),
        hash(idr[codec])
      )
      const changed = Buffer.concat([idr[codec], Buffer.from([0, 1])])
      expectMismatch(mediaFixture({ codec, nals: [changed] }), hash(idr[codec]))
    })

    it(`rejects ${codec} continuation slices and illegal NAL headers`, () => {
      for (const index of [0, codec === "h264" ? 1 : 2]) {
        const nal = Buffer.from(idr[codec])
        nal[index] ^= 0x80
        expectMismatch(mediaFixture({ codec, nals: [nal] }), hash(nal))
      }
    })

    it(`rejects an empty ${codec} sample or one without a VCL`, () => {
      expectMismatch(mediaFixture({ codec, nals: [] }), hash(idr[codec]))
      expectMismatch(
        mediaFixture({ codec, nals: [prefixNal[codec]] }),
        hash(idr[codec])
      )
    })
  }

  it.each([
    Buffer.from([0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 9, 0x65, 0x80]),
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x65, 0x80]),
    Buffer.concat([sampleData([idr.h264], 4), Buffer.from([0])]),
  ])("rejects truncated, zero or overflowing length prefixes %#", (data) => {
    expectMismatch(mediaFixture({ data }))
  })

  it.each([19, 20, 21])("does not skip H.264 extension VCL type %i", (type) => {
    expectMismatch(
      mediaFixture({ nals: [Buffer.from([0x60 | type, 0x80]), idr.h264] })
    )
  })

  it.each([16, 17, 18, 21, 22, 23])(
    "rejects non-IDR HEVC IRAP type %i",
    (type) => {
      expectMismatch(
        mediaFixture({
          codec: "hevc",
          nals: [Buffer.from([type << 1, 1, 0x80])],
        }),
        hash(idr.hevc)
      )
    }
  )

  it.each([
    Buffer.from([0x26, 0, 0x80]),
    Buffer.from([0x27, 1, 0x80]),
    Buffer.from([0x26, 9, 0x80]),
    Buffer.from([0x26, 2, 0x80]),
  ])(
    "rejects HEVC zero temporal IDs, other layers or nonzero IDR temporal levels %#",
    (nal) =>
      expectMismatch(mediaFixture({ codec: "hevc", nals: [nal] }), hash(nal))
  )

  it.each(["h264", "hevc"] as const)(
    "rejects short or unknown-version %s codec records",
    (codec) => {
      for (const privateData of [
        Buffer.alloc(0),
        Buffer.alloc(codec === "h264" ? 6 : 22),
        Buffer.alloc(codec === "h264" ? 7 : 23),
      ])
        expectMismatch(mediaFixture({ codec, privateData }), hash(idr[codec]))
    }
  )

  it("rejects mismatched codec declarations and dependency flags", () => {
    const media = mediaFixture()
    expectMismatch({ ...media, codec: "hevc" })
    expectMismatch({ ...media, codec: "unsupported" as VideoCodec })
    expectMismatch(mediaFixture({ keyframe: false }))
  })

  it("caps NAL traversal without allowing zero-length loops", () => {
    confirmPlaybackFrame(
      mediaFixture({ nals: [...Array(4095).fill(prefixNal.h264), idr.h264] }),
      hash(idr.h264)
    )
    expectMismatch(
      mediaFixture({ nals: [...Array(4096).fill(prefixNal.h264), idr.h264] })
    )
  })

  it("rejects oversized inputs before invoking the demuxer", () => {
    const media = mediaFixture()
    const spy = vi.spyOn(FragmentedMp4Demuxer.prototype, "push")
    try {
      expectMismatch({ ...media, init: Buffer.alloc(256 * 1024 + 1) })
      expectMismatch({ ...media, media: Buffer.alloc(MAX_MEDIA_BUFFER + 1) })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("maps malformed container and private hash values to one fixed error", () => {
    const media = mediaFixture()
    for (const expected of [
      "",
      "a".repeat(63),
      "A".repeat(64),
      "private-input",
    ])
      expectMismatch(media, expected)
    for (const invalid of [
      { ...media, init: media.init.subarray(0, 30) },
      { ...media, media: media.media.subarray(0, media.media.length - 1) },
    ])
      expectMismatch(invalid)
    try {
      confirmPlaybackFrame(media, "a".repeat(64))
      throw new Error("Expected a proof failure")
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect(String(error)).not.toContain("a".repeat(64))
    }
  })
})
