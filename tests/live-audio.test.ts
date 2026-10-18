import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import { copiedAudio } from "../server/live-audio"
import { mp4Boxes } from "../server/mp4"
import { decodeG711 } from "../lib/g711"

const file = readFileSync(
  new URL("../fixtures/synthetic-g711-audio.mov", import.meta.url)
)
const top = mp4Boxes(file),
  first = top.find((box) => box.type === "moof")!
const init = file.subarray(0, first.start)
const fragments = top
  .filter((box) => box.type === "moof")
  .map((moof) => {
    const mdat = top.find(
      (box) => box.type === "mdat" && box.start > moof.start
    )!
    return file.subarray(moof.start, mdat.end)
  })

describe("copied G.711 audio", () => {
  it("extracts encoded packets and media timestamps without decoding on the server", () => {
    const audio = fragments.map((fragment) => copiedAudio(init, fragment))
    expect(audio[0]).toMatchObject({
      codec: "alaw",
      sampleRate: 8000,
      channels: 1,
      startSeconds: 0,
    })
    expect(audio.reduce((bytes, chunk) => bytes + chunk.data.length, 0)).toBe(
      24000
    )
    for (let index = 1; index < audio.length; index++)
      expect(audio[index].startSeconds).toBeCloseTo(
        audio[index - 1].startSeconds + audio[index - 1].data.length / 8000
      )
    expect(Math.max(...decodeG711(audio[0].data, "alaw"))).toBeGreaterThan(0.1)
  })
  it.each(["alaw", "ulaw"] as const)(
    "matches the independent FFmpeg reference for all 256 %s code words",
    (codec) => {
      // Reference: FFmpeg input bytes 00..ff, -f alaw/mulaw -ar 8000 -ac 1,
      // decode to -c:a pcm_s16le -f s16le. The hash covers all output samples.
      const values = decodeG711(
        Uint8Array.from({ length: 256 }, (_, i) => i),
        codec
      )
      const pcm = Buffer.alloc(512)
      values.forEach((sample, index) =>
        pcm.writeInt16LE(Math.round(sample * 32768), index * 2)
      )
      expect(createHash("sha256").update(pcm).digest("hex")).toBe(
        codec === "alaw"
          ? "e04788d110e58ff8c70c93b8480190d973e3b67876b6119abbaec766cc75c174"
          : "3dab54339e520bb2c924826e3b72a917a2b612e9fd12fc867500f1d983a75827"
      )
    }
  )
  it("rejects malformed, unsupported and truncated audio metadata", () => {
    expect(() => copiedAudio(Buffer.alloc(0), fragments[0])).toThrow()
    expect(() => copiedAudio(init, Buffer.from("invalid"))).toThrow()
    const unsupported = Buffer.from(init)
    unsupported.write("mp4a", unsupported.indexOf("alaw"), "ascii")
    expect(() => copiedAudio(unsupported, fragments[0])).toThrow()
  })
})
