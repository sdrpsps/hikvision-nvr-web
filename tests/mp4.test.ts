import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { AppError } from "../server/errors"
import { mp4Boxes, mp4U32, splitFragmentedMp4 } from "../server/mp4"

function words(...values: number[]) {
  const data = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => data.writeUInt32BE(value, index * 4))
  return data
}

function box(type: string, data: Buffer) {
  return Buffer.concat([words(data.length + 8), Buffer.from(type), data])
}

function fullBox(type: string, flags: number, data: Buffer) {
  return box(type, Buffer.concat([words(flags), data]))
}

function child(data: Buffer, ...path: string[]): Buffer {
  let current = data
  for (const type of path) {
    const found = mp4Boxes(current).find((item) => item.type === type)
    if (!found) throw new Error(`Fixture is missing ${type}`)
    current = found.data
  }
  return current
}

const fixture = readFileSync(
  new URL("../fixtures/synthetic-preview.mp4", import.meta.url)
)
const init = splitFragmentedMp4(fixture).init
const trackId = mp4U32(child(init, "moov", "trak", "tkhd"), 12)
const timescale = mp4U32(child(init, "moov", "trak", "mdia", "mdhd"), 12)
const sync = 0x02000000
const dependent = 0x01010000

// Structural fixtures isolate the ISO BMFF flag inheritance rules. Real encoded
// H.264/HEVC samples are separately checked below using stream-copy fragments.
function flagsFixture({
  trexFlags,
  defaultFlags,
  firstFlags,
  sampleFlags,
  composition,
}: {
  trexFlags?: number
  defaultFlags?: number
  firstFlags?: number
  sampleFlags?: readonly number[]
  composition?: readonly number[]
} = {}) {
  const initialized = Buffer.concat(
    mp4Boxes(init).map((item) => {
      if (item.type !== "moov") return init.subarray(item.start, item.end)
      return box(
        "moov",
        Buffer.concat(
          mp4Boxes(item.data).map((part) => {
            if (part.type !== "mvex")
              return item.data.subarray(part.start, part.end)
            return box(
              "mvex",
              trexFlags === undefined
                ? Buffer.alloc(0)
                : fullBox("trex", 0, words(trackId, 1, timescale, 1, trexFlags))
            )
          })
        )
      )
    })
  )
  const count = sampleFlags?.length ?? composition?.length ?? 2
  const samples = Array.from({ length: count }, (_, index) => [
    1,
    ...(sampleFlags ? [sampleFlags[index]] : []),
    ...(composition ? [composition[index]] : []),
  ]).flat()
  return Buffer.concat([
    initialized,
    box(
      "moof",
      Buffer.concat([
        fullBox("mfhd", 0, words(1)),
        box(
          "traf",
          Buffer.concat([
            fullBox(
              "tfhd",
              0x020008 | (defaultFlags === undefined ? 0 : 32),
              words(
                trackId,
                timescale,
                ...(defaultFlags === undefined ? [] : [defaultFlags])
              )
            ),
            fullBox("tfdt", 0, words(0)),
            fullBox(
              "trun",
              0x200 |
                (firstFlags === undefined ? 0 : 4) |
                (sampleFlags ? 0x400 : 0) |
                (composition ? 0x800 : 0),
              words(
                count,
                ...(firstFlags === undefined ? [] : [firstFlags]),
                ...samples
              )
            ),
          ])
        ),
      ])
    ),
    box("mdat", Buffer.alloc(count)),
  ])
}

function copiedFragments(name: string) {
  const source = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
  const result = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-an",
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration",
      "500000",
      "-f",
      "mp4",
      "pipe:1",
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }
  )
  if (result.error || result.status !== 0)
    throw new Error("Synthetic stream-copy fragment generation failed")
  const data = result.stdout
  const whole = splitFragmentedMp4(data)
  const top = mp4Boxes(data)
  const fragments = top.flatMap((part, index) => {
    if (part.type !== "moof") return []
    const mdat = top[index + 1]
    if (mdat?.type !== "mdat")
      throw new Error("Synthetic fragment is incomplete")
    return [
      splitFragmentedMp4(
        Buffer.concat([whole.init, data.subarray(part.start, mdat.end)])
      ),
    ]
  })
  return { whole, fragments }
}

describe("fragmented MP4 timing and random-access metadata", () => {
  it("distinguishes the first packet's PTS from a later minimum presentation PTS", () => {
    const media = splitFragmentedMp4(
      flagsFixture({ firstFlags: sync, composition: [2 * timescale, 0] })
    )
    expect(media.firstPresentationSeconds).toBe(2)
    expect(media.startSeconds).toBe(1)
    expect(media.decodeStartSeconds).toBe(0)
  })
  for (const [name, codec] of [
    ["synthetic-preview.mp4", "h264"],
    ["synthetic-preview-hevc.mp4", "hevc"],
  ] as const)
    it(`inspects copied ${codec} sub-GOP fragments without changing presentation timing`, () => {
      const { whole, fragments } = copiedFragments(name)
      expect(whole.codec).toBe(codec)
      expect(fragments.length).toBeGreaterThan(3)
      expect(fragments[0].startsWithKeyframe).toBe(true)
      expect(fragments.slice(1).some((part) => !part.startsWithKeyframe)).toBe(
        true
      )
      expect(fragments.every((part) => part.sampleCount > 0)).toBe(true)
      expect(
        fragments.reduce((sum, part) => sum + part.decodeDurationSeconds, 0)
      ).toBeCloseTo(whole.decodeDurationSeconds, 6)
      expect(fragments.reduce((sum, part) => sum + part.sampleCount, 0)).toBe(
        whole.sampleCount
      )
      for (let index = 1; index < fragments.length; index++) {
        const previous = fragments[index - 1]
        expect(fragments[index].decodeStartSeconds).toBeCloseTo(
          previous.decodeStartSeconds + previous.decodeDurationSeconds,
          6
        )
      }
      if (codec === "hevc") {
        expect(
          fragments.reduce((sum, part) => sum + part.durationSeconds, 0)
        ).toBeGreaterThan(whole.durationSeconds + 0.05)
        expect(
          fragments.some(
            (part) => part.durationSeconds > part.decodeDurationSeconds + 0.01
          )
        ).toBe(true)
      }
    })

  it.each([
    [{ trexFlags: sync }, true],
    [{ trexFlags: sync, defaultFlags: dependent }, false],
    [{ trexFlags: dependent, defaultFlags: sync }, true],
    [{ defaultFlags: dependent, firstFlags: sync }, true],
    [{ defaultFlags: sync, firstFlags: dependent }, false],
    [{ defaultFlags: sync, sampleFlags: [dependent, sync] }, false],
    [{ defaultFlags: dependent, sampleFlags: [sync, dependent] }, true],
    [{}, false],
    [{ trexFlags: 0 }, false],
    [{ firstFlags: sync | 0x10000 }, false],
  ] as const)(
    "resolves first-sample flags conservatively: %j",
    (options, value) => {
      const media = splitFragmentedMp4(flagsFixture(options))
      expect(media.startsWithKeyframe).toBe(value)
      expect(media.decodeStartSeconds).toBe(0)
      expect(media.decodeDurationSeconds).toBe(2)
      expect(media.durationSeconds).toBe(2)
      expect(media.startSeconds).toBe(0)
    }
  )

  it("rejects mutually exclusive first-sample and per-sample flags", () => {
    expect(() =>
      splitFragmentedMp4(
        flagsFixture({ firstFlags: sync, sampleFlags: [sync, dependent] })
      )
    ).toThrow(AppError)
  })

  it.each(["tfhd", "trun"] as const)(
    "rejects truncated flags declared by %s",
    (type) => {
      const data = flagsFixture()
      const value = child(data, "moof", "traf", type)
      value.writeUInt32BE(mp4U32(value, 0) | (type === "tfhd" ? 32 : 0x400))
      expect(() => splitFragmentedMp4(data)).toThrow(AppError)
    }
  )

  it("rejects reserved dependency flags and a fragment for another track", () => {
    expect(() =>
      splitFragmentedMp4(flagsFixture({ firstFlags: 0x03000000 }))
    ).toThrow(AppError)
    const data = flagsFixture({ firstFlags: sync })
    child(data, "moof", "traf", "tfhd").writeUInt32BE(trackId + 1, 4)
    expect(() => splitFragmentedMp4(data)).toThrow(AppError)
  })
})
