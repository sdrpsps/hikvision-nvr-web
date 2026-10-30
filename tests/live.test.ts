import { readFileSync } from "node:fs"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawnSync, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi } from "vitest"
import {
  LiveSessions,
  liveArguments,
  LIVE_FRAGMENT_DURATION_US,
  MAX_LIVE_SEGMENTS,
  MAX_LIVE_SESSIONS,
} from "../server/live"
import { readNvrConfig } from "../server/config"
import { mp4Boxes, mp4U32, splitFragmentedMp4 } from "../server/mp4"
import { createApp } from "../server/app"
import { NvrService } from "../server/recordings"
import { PreviewSessions } from "../server/preview"
import { liveSchema } from "../shared/contracts"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test-user",
  NVR_PASSWORD: "test-secret",
})
const media = splitFragmentedMp4(
  readFileSync(new URL("../fixtures/synthetic-preview.mp4", import.meta.url))
)

function childBox(data: Buffer, ...path: string[]): Buffer {
  for (const type of path) {
    const found = mp4Boxes(data).find((item) => item.type === type)
    if (!found) throw new Error(`Fixture is missing ${type}`)
    data = found.data
  }
  return data
}
const trackId = mp4U32(childBox(media.init, "moov", "trak", "tkhd"), 12)
const timescale = mp4U32(
  childBox(media.init, "moov", "trak", "mdia", "mdhd"),
  12
)
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
// Structural samples exercise lifecycle limits at precise durations. Encoded
// H.264/HEVC stream-copy fragments are separately exercised below.
function timedFragment(
  durationSeconds: number,
  independent = false,
  startSeconds = 0,
  sourceTimescale = timescale
) {
  return Buffer.concat([
    box(
      "moof",
      Buffer.concat([
        fullBox("mfhd", 0, words(1)),
        box(
          "traf",
          Buffer.concat([
            fullBox(
              "tfhd",
              0x020038,
              words(
                trackId,
                Math.round(durationSeconds * sourceTimescale),
                1,
                independent ? 0x02000000 : 0x01010000
              )
            ),
            fullBox(
              "tfdt",
              0,
              words(Math.round(startSeconds * sourceTimescale))
            ),
            fullBox("trun", 0, words(1)),
          ])
        ),
      ])
    ),
    box("mdat", Buffer.alloc(1)),
  ])
}
function copiedFragments(name: string) {
  const result = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
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
      String(LIVE_FRAGMENT_DURATION_US),
      "-f",
      "mp4",
      "pipe:1",
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }
  )
  if (result.error || result.status !== 0)
    throw new Error("Synthetic stream-copy fragment generation failed")
  const data = result.stdout,
    whole = splitFragmentedMp4(data),
    top = mp4Boxes(data)
  const fragments = top.flatMap((part, index) => {
    if (part.type !== "moof") return []
    const mdat = top[index + 1]
    if (mdat?.type !== "mdat") throw new Error("Incomplete synthetic fragment")
    return [data.subarray(part.start, mdat.end)]
  })
  return {
    whole,
    fragments,
    timescale: mp4U32(childBox(whole.init, "moov", "trak", "mdia", "mdhd"), 12),
  }
}
function offsetDecodeTime(
  fragment: Buffer,
  offsetSeconds: number,
  sourceTimescale: number
) {
  const data = Buffer.from(fragment),
    moof = mp4Boxes(data).find((part) => part.type === "moof")!,
    traf = mp4Boxes(moof.data).find((part) => part.type === "traf")!,
    tfdt = mp4Boxes(traf.data).find((part) => part.type === "tfdt")!,
    at = moof.start + 8 + traf.start + 8 + tfdt.start + 8 + 4,
    offset = Math.round(offsetSeconds * sourceTimescale)
  if (tfdt.data[0] === 1)
    data.writeBigUInt64BE(data.readBigUInt64BE(at) + BigInt(offset), at)
  else data.writeUInt32BE(data.readUInt32BE(at) + offset, at)
  return data
}
function playlistEntries(playlist: string) {
  return Array.from(
    playlist.matchAll(/#EXTINF:([\d.]+),\n(\d+\.m4s)/g),
    (m) => ({
      duration: Number(m[1]),
      asset: m[2],
    })
  )
}
function playlistStartOffset(playlist: string) {
  const match = /#EXT-X-START:TIME-OFFSET=(-?[\d.]+),PRECISE=NO\n/.exec(
    playlist
  )
  if (!match) throw new Error("Live playlist is missing its safe start offset")
  return Number(match[1])
}

function setup(ttl?: number, automatic = true) {
  const children: (ChildProcess & {
    output: PassThrough
    audio: PassThrough
  })[] = []
  const launcher = vi.fn<(args: string[]) => ChildProcess>(() => {
    const child = Object.assign(new EventEmitter(), {
      output: new PassThrough(),
      stderr: new PassThrough(),
      audio: new PassThrough(),
      kill: vi.fn(),
    })
    Object.assign(child, {
      stdout: child.output,
      stdio: [null, child.output, child.stderr, child.audio],
    })
    children.push(child as unknown as (typeof children)[number])
    if (automatic)
      queueMicrotask(() => {
        child.output.write(media.init)
        child.output.write(media.media)
      })
    return child as unknown as ChildProcess
  })
  return { sessions: new LiveSessions(launcher, ttl), children, launcher }
}
const signal = () => new AbortController().signal
const resolve = async () => "101"

describe("live copy-only lifecycle", () => {
  it("builds a fixed trusted RTSP path with copy-only output", () => {
    const args = liveArguments(config, "101")
    expect(args[args.indexOf("-i") + 1]).toBe(
      "rtsp://test-user:test-secret@nvr.test:554/Streaming/Channels/101"
    )
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual([
      "-c:v",
      "copy",
    ])
    expect(args.at(-1)).toContain("pipe:1")
    expect(args.at(-1)).toContain("pipe:3")
    expect(args.at(-1)?.split("|")[0]).not.toContain("frag_duration")
    expect(args).toContain("0:a:0?")
    expect(args).not.toContain("-an")
    expect(args.join(" ")).not.toMatch(/libx26| -vf | -filter/)
  })
  it("skips a dependent prefix and waits for three accepted seconds from a keyframe", async () => {
    const { sessions, children, launcher } = setup(undefined, false)
    try {
      let ready = false
      const pending = sessions
        .create(config, resolve, signal())
        .then((value) => {
          ready = true
          return value
        })
      await Promise.resolve()
      expect(launcher.mock.calls[0][0].at(-1)?.split("|")[0]).toContain(
        `frag_duration=${LIVE_FRAGMENT_DURATION_US}`
      )
      const output = children[0].output
      output.write(media.init)
      for (let index = 0; index < 3; index++)
        output.write(timedFragment(0.5, false, index * 0.5))
      const key = timedFragment(0.5, true, 10.25)
      output.write(key)
      for (let index = 1; index < 5; index++)
        output.write(timedFragment(0.5, false, 10.25 + index * 0.5))
      await Promise.resolve()
      await Promise.resolve()
      expect(ready).toBe(false)
      output.write(timedFragment(0.5, false, 12.75))
      const session = await pending
      expect(sessions.asset(session.id, "0.m4s")).toEqual(key)
      expect(playlistEntries(sessions.playlist(session.id))).toHaveLength(6)
      expect(sessions.audio(session.id, -1).videoStartSeconds).toBe(10.25)
    } finally {
      sessions.dispose()
    }
  })
  it("observes output bytes, dependent media, independent media and readiness separately", async () => {
    vi.useFakeTimers()
    const { sessions, children } = setup(undefined, false)
    try {
      let ready = false
      const pending = sessions
        .create(
          config,
          () =>
            new Promise<string>((done) => setTimeout(() => done("101"), 10)),
          signal()
        )
        .then((value) => {
          ready = true
          return value
        })
      await Promise.resolve()
      expect(children).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(20)
      const output = children[0].output
      output.write(media.init.subarray(0, 4))
      await vi.advanceTimersByTimeAsync(10)
      output.write(media.init.subarray(4))
      const dependent = timedFragment(0.5, false, 5)
      await vi.advanceTimersByTimeAsync(5)
      output.write(dependent.subarray(0, -1))
      await vi.advanceTimersByTimeAsync(5)
      output.write(dependent.subarray(-1))
      await vi.advanceTimersByTimeAsync(10)
      output.write(timedFragment(0.5, false, 5.5))
      await vi.advanceTimersByTimeAsync(30)
      output.write(timedFragment(0.5, true, 10))
      for (let index = 1; index < 5; index++) {
        await vi.advanceTimersByTimeAsync(100)
        output.write(timedFragment(0.5, false, 10 + index * 0.5))
      }
      await Promise.resolve()
      expect(ready).toBe(false)
      await vi.advanceTimersByTimeAsync(100)
      output.write(timedFragment(0.5, false, 12.5))
      const session = await pending
      const expected = {
        firstByteMs: 20,
        firstFragmentMs: 40,
        firstIndependentFragmentMs: 80,
        readyMs: 580,
      }
      expect(session.startup).toEqual(expected)
      expect(session.targetDurationSeconds).toBe(1)
      expect(liveSchema.parse(session).startup).toEqual(expected)
      expect(sessions.audio(session.id, -1).videoStartSeconds).toBe(10)
      await vi.advanceTimersByTimeAsync(100)
      output.write(timedFragment(0.5, true, 13))
      expect(session.startup).toEqual(expected)
      sessions.dispose()
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      sessions.dispose()
      vi.useRealTimers()
    }
  })
  it("accepts zero elapsed stages and keeps startup optional for older responses", async () => {
    vi.useFakeTimers()
    const { sessions, children } = setup(undefined, false)
    try {
      const pending = sessions.create(config, resolve, signal())
      await Promise.resolve()
      children[0].output.write(Buffer.concat([media.init, media.media]))
      vi.advanceTimersByTime(10)
      children[0].output.write(timedFragment(0.5, true, 3))
      const session = await pending
      const { startup, targetDurationSeconds, ...legacy } = session
      expect(targetDurationSeconds).toBe(1)
      expect(startup).toEqual({
        firstByteMs: 0,
        firstFragmentMs: 0,
        firstIndependentFragmentMs: 0,
        readyMs: 0,
      })
      expect(liveSchema.safeParse(session).success).toBe(true)
      expect(liveSchema.safeParse(legacy).success).toBe(true)
      for (const value of [-1, 0, NaN, Infinity, -Infinity])
        expect(
          liveSchema.safeParse({ ...session, targetDurationSeconds: value })
            .success
        ).toBe(false)
      for (const field of Object.keys(startup))
        for (const value of [-1, NaN, Infinity, -Infinity])
          expect(
            liveSchema.safeParse({
              ...session,
              startup: { ...startup, [field]: value },
            }).success
          ).toBe(false)
    } finally {
      sessions.dispose()
      vi.useRealTimers()
    }
  })
  it.each([
    ["cancel", "MEDIA_CANCELLED"],
    ["close", "LIVE_INTERRUPTED"],
    ["invalid", "LIVE_INVALID_MEDIA"],
    ["timeout", "LIVE_TIMEOUT"],
  ])("does not report readiness after startup %s", async (failure, code) => {
    vi.useFakeTimers()
    const { sessions, children } = setup(undefined, false)
    const controller = new AbortController()
    try {
      const completed = vi.fn()
      const pending = sessions.create(config, resolve, controller.signal)
      void pending.then(completed, () => {})
      const rejection = expect(pending).rejects.toMatchObject({ code })
      await Promise.resolve()
      const output = children[0].output
      output.write(media.init)
      output.write(timedFragment(0.5, true))
      if (failure === "cancel") controller.abort()
      else if (failure === "close") children[0].emit("close", 1)
      else if (failure === "invalid") output.write(Buffer.alloc(8))
      else await vi.advanceTimersByTimeAsync(20_001)
      await rejection
      output.write(media.media)
      children[0].emit("close", 0)
      await Promise.resolve()
      expect(completed).not.toHaveBeenCalled()
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      sessions.dispose()
      vi.useRealTimers()
    }
  })
  it("requires three target durations before becoming ready when the target exceeds one second", async () => {
    const { sessions, children } = setup(undefined, false)
    try {
      let ready = false
      const pending = sessions
        .create(config, resolve, signal())
        .then((value) => {
          ready = true
          return value
        })
      await Promise.resolve()
      const output = children[0].output
      output.write(media.init)
      output.write(timedFragment(1.6, true))
      output.write(timedFragment(1.4))
      output.write(timedFragment(1.4))
      await Promise.resolve()
      await Promise.resolve()
      expect(ready).toBe(false)
      output.write(timedFragment(1.6))
      const session = await pending
      expect(session.targetDurationSeconds).toBe(2)
      expect(sessions.playlist(session.id)).toContain(
        "#EXT-X-TARGETDURATION:2\n"
      )
      expect(
        playlistEntries(sessions.playlist(session.id)).reduce(
          (sum, entry) => sum + entry.duration,
          0
        )
      ).toBeCloseTo(6, 3)
    } finally {
      sessions.dispose()
    }
  })
  it.each([
    {
      target: 1,
      duration: 0.5,
      gopFragments: 8,
      fragmentCount: 36,
      firstSequence: 8,
      startSequence: 24,
      offset: -6,
    },
    {
      target: 2,
      duration: 2,
      gopFragments: 4,
      fragmentCount: 16,
      firstSequence: 8,
      startSequence: 12,
      offset: -8,
    },
  ])(
    "starts target-$target live playlists at the latest safe independent fragment",
    async ({
      target,
      duration,
      gopFragments,
      fragmentCount,
      firstSequence,
      startSequence,
      offset,
    }) => {
      const { sessions, children } = setup(undefined, false)
      try {
        const pending = sessions.create(config, resolve, signal())
        await Promise.resolve()
        const output = children[0].output
        output.write(media.init)
        output.write(timedFragment(duration, false, 100))
        const initialCount = (3 * target) / duration
        for (let index = 0; index < initialCount; index++)
          output.write(
            timedFragment(
              duration,
              index % gopFragments === 0,
              index * duration
            )
          )
        const session = await pending
        const initial = sessions.playlist(session.id)
        expect(session.targetDurationSeconds).toBe(target)
        expect(playlistStartOffset(initial)).toBe(-3 * target)
        expect(playlistStartOffset(initial)).toBeLessThan(0)
        expect(playlistEntries(initial)).toHaveLength(initialCount)
        expect(sessions.audio(session.id, -1).videoStartSeconds).toBe(0)
        expect(
          splitFragmentedMp4(
            Buffer.concat([media.init, sessions.asset(session.id, "0.m4s")])
          ).startsWithKeyframe
        ).toBe(true)
        for (let index = initialCount; index < fragmentCount; index++)
          output.write(
            timedFragment(
              duration,
              index % gopFragments === 0,
              index * duration
            )
          )
        const playlist = sessions.playlist(session.id)
        const entries = playlistEntries(playlist)
        const retained = entries.map((entry) =>
          splitFragmentedMp4(
            Buffer.concat([media.init, sessions.asset(session.id, entry.asset)])
          )
        )
        const total = entries.reduce((sum, entry) => sum + entry.duration, 0)
        const edge =
          retained.at(-1)!.decodeStartSeconds +
          retained.at(-1)!.decodeDurationSeconds
        const actualOffset = playlistStartOffset(playlist)
        const selected = retained.find(
          (fragment) =>
            Math.abs(fragment.decodeStartSeconds - (edge + actualOffset)) <=
            1.001e-6
        )
        const eligible = retained.filter(
          (fragment) =>
            fragment.startsWithKeyframe &&
            edge - fragment.decodeStartSeconds >= 3 * target
        )
        expect(playlist).toContain(`#EXT-X-TARGETDURATION:${target}\n`)
        expect(playlist).not.toContain("#EXT-X-INDEPENDENT-SEGMENTS")
        expect(total).toBeGreaterThanOrEqual(12)
        expect(entries[0].asset).toBe(`${firstSequence}.m4s`)
        expect(retained[0].startsWithKeyframe).toBe(true)
        expect(Math.abs(actualOffset - offset)).toBeLessThanOrEqual(1.001e-6)
        expect(actualOffset).toBeLessThanOrEqual(-3 * target)
        expect(total + actualOffset).toBeGreaterThan(0)
        expect(selected?.startsWithKeyframe).toBe(true)
        expect(selected?.decodeStartSeconds).toBe(startSequence * duration)
        expect(selected).toBe(eligible.at(-1))
        expect(
          retained
            .slice(0, retained.indexOf(selected!))
            .some((fragment) => !fragment.startsWithKeyframe)
        ).toBe(true)
        expect(() => sessions.asset(session.id, "0.m4s")).toThrow()
        expect(children[0].kill).not.toHaveBeenCalled()
      } finally {
        sessions.dispose()
      }
    }
  )
  it("omits a start hint when first-window EXTINF rounding leaves less than three target durations", async () => {
    const { sessions, children } = setup(undefined, false)
    try {
      const pending = sessions.create(config, resolve, signal())
      await Promise.resolve()
      const output = children[0].output
      output.write(media.init)
      for (let index = 0; index < 9; index++)
        output.write(timedFragment(1 / 3, index === 0, index / 3))
      const session = await pending
      const playlist = sessions.playlist(session.id)
      const entries = playlistEntries(playlist)
      const serializedDuration = entries.reduce(
        (sum, entry) => sum + entry.duration,
        0
      )
      expect(session.targetDurationSeconds).toBe(1)
      expect(entries).toHaveLength(9)
      expect(entries.every((entry) => entry.duration === 0.333333)).toBe(true)
      expect(serializedDuration).toBeCloseTo(2.999997, 9)
      expect(serializedDuration).toBeLessThan(3)
      expect(playlist).not.toContain("#EXT-X-START:")
      expect(entries[0].asset).toBe("0.m4s")
      expect(
        splitFragmentedMp4(
          Buffer.concat([media.init, sessions.asset(session.id, "0.m4s")])
        ).startsWithKeyframe
      ).toBe(true)

      // Exercise the installed engine's no-offset live-start branch without
      // network requests or a browser MediaSource implementation.
      const { default: Hls } = await import("hls.js")
      const hls = new Hls({
        autoStartLoad: false,
        enableWorker: false,
        lowLatencyMode: false,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
      })
      try {
        const details = {
          live: true,
          startTimeOffset: null,
          edge: serializedDuration,
          totalduration: serializedDuration,
          targetduration: 1,
          holdBack: 0,
          partHoldBack: 0,
          age: 0,
          fragmentStart: 0,
        }
        const controller = (
          hls as unknown as {
            streamController: {
              levels: { details: typeof details }[]
              levelLastLoaded: { details: typeof details }
              startPosition: number
              nextLoadPosition: number
              setStartPosition(level: typeof details, sliding: number): void
            }
          }
        ).streamController
        const level = { details }
        controller.levels = [level]
        controller.levelLastLoaded = level
        controller.setStartPosition(details, 0)
        expect(hls.liveSyncPosition).toBe(0)
        expect(controller.startPosition).toBe(-1)
        expect(controller.nextLoadPosition).toBe(0)
      } finally {
        hls.destroy()
      }

      output.write(timedFragment(1 / 3, false, 3))
      const nextPlaylist = sessions.playlist(session.id)
      expect(playlistStartOffset(nextPlaylist)).toBeCloseTo(-3.33333, 9)
      expect(playlistEntries(nextPlaylist)).toHaveLength(10)
      expect(children[0].kill).not.toHaveBeenCalled()
    } finally {
      sessions.dispose()
    }
  })
  it("keeps the full three-target holdback after moving an interior start hint", async () => {
    const { sessions, children } = setup(undefined, false)
    try {
      const pending = sessions.create(config, resolve, signal())
      await Promise.resolve()
      const output = children[0].output
      output.write(media.init)
      const feed = (index: number) =>
        output.write(timedFragment(0.5, index % 6 === 0, index * 0.5))
      for (let index = 0; index < 6; index++) feed(index)
      const session = await pending
      // At the window head there is no preceding dependent fragment to avoid.
      expect(playlistStartOffset(sessions.playlist(session.id))).toBe(-3)
      for (let index = 6; index < 36; index++) feed(index)

      const playlist = sessions.playlist(session.id)
      const entries = playlistEntries(playlist)
      const fragments = entries.map((entry) =>
        splitFragmentedMp4(
          Buffer.concat([media.init, sessions.asset(session.id, entry.asset)])
        )
      )
      const independent = fragments.filter(
        (fragment) => fragment.startsWithKeyframe
      )
      const edge = fragments.at(-1)!.decodeStartSeconds + 0.5
      const offset = playlistStartOffset(playlist)
      const position = edge + offset
      const selected = fragments.find(
        (fragment) =>
          position >= fragment.decodeStartSeconds &&
          position <
            fragment.decodeStartSeconds + fragment.decodeDurationSeconds
      )
      expect(entries[0].asset).toBe("12.m4s")
      expect(edge - independent.at(-1)!.decodeStartSeconds).toBe(3)
      expect(offset).toBeLessThanOrEqual(-3)
      expect(Math.abs(offset + 5.999999)).toBeLessThan(1e-9)
      expect(selected).toBe(independent.at(-2))
      expect(selected).not.toBe(fragments[0])
      expect(selected?.decodeStartSeconds).toBe(12)
      expect(selected?.startsWithKeyframe).toBe(true)
      expect(playlist).toContain("PRECISE=NO\n")
      expect(children[0].kill).not.toHaveBeenCalled()
    } finally {
      sessions.dispose()
    }
  })
  it("keeps noninteger 30fps start hints inside an independent fragment on the serialized HLS clock", async () => {
    type Fragment = {
      sn: number
      start: number
      duration: number
      independent: boolean
    }
    // Import the installed finder without type-checking hls.js's build-only
    // source globals. No copy of its lookup logic is maintained in this test.
    const dependency =
      "../node_modules/hls.js/src/controller/fragment-finders.ts"
    const { findFragmentByPTS } = await vi.importActual<{
      findFragmentByPTS(
        previous: null,
        fragments: Fragment[],
        position: number,
        tolerance: number
      ): Fragment | null
    }>(dependency)
    const { sessions, children } = setup(undefined, false)
    const sourceTimescale = 30_000
    const duration = 16 / 30
    const init = Buffer.from(media.init)
    childBox(init, "moov", "trak", "mdia", "mdhd").writeUInt32BE(
      sourceTimescale,
      12
    )
    try {
      const pending = sessions.create(config, resolve, signal())
      await Promise.resolve()
      const output = children[0].output
      output.write(init)
      const feed = (index: number) =>
        output.write(
          timedFragment(
            duration,
            index % 6 === 0,
            index * duration,
            sourceTimescale
          )
        )
      for (let index = 0; index < 6; index++) feed(index)
      const session = await pending
      for (let index = 6; index < 36; index++) feed(index)

      const playlist = sessions.playlist(session.id)
      const entries = playlistEntries(playlist)
      let edge = 0
      const fragments: Fragment[] = entries.map((entry) => {
        const encoded = splitFragmentedMp4(
          Buffer.concat([init, sessions.asset(session.id, entry.asset)])
        )
        const fragment = {
          sn: Number(entry.asset.slice(0, -4)),
          start: edge,
          duration: entry.duration,
          independent: encoded.startsWithKeyframe,
        }
        edge += entry.duration
        return fragment
      })
      const offset = playlistStartOffset(playlist)
      const position = Math.max(0, edge + offset)
      // hls.js explicitly uses zero lookup tolerance for its first fragment.
      const selected = findFragmentByPTS(null, fragments, position, 0)
      expect(fragments[0].sn).toBe(12)
      expect(fragments[0].independent).toBe(true)
      expect(
        fragments.every((fragment) => fragment.duration === 0.533333)
      ).toBe(true)
      expect(selected?.sn).toBe(30)
      expect(selected?.independent).toBe(true)
      expect(position).toBeGreaterThan(selected!.start)
      expect(position - selected!.start).toBeLessThanOrEqual(1.001e-6)
      expect(position).toBeLessThan(selected!.start + selected!.duration)
      expect(-offset).toBeGreaterThanOrEqual(3)
      expect(playlist).toContain("PRECISE=NO\n")
      expect(children[0].kill).not.toHaveBeenCalled()
    } finally {
      sessions.dispose()
    }
  })
  it("keeps target duration fixed and releases the session if a fragment exceeds it", async () => {
    const { sessions, children } = setup(undefined, false)
    try {
      const pending = sessions.create(config, resolve, signal())
      await Promise.resolve()
      const output = children[0].output
      output.write(media.init)
      for (let index = 0; index < 6; index++)
        output.write(timedFragment(0.5, index === 0))
      const session = await pending
      output.write(timedFragment(1.4))
      expect(sessions.playlist(session.id)).toContain(
        "#EXT-X-TARGETDURATION:1\n"
      )
      output.write(timedFragment(1.5))
      expect(sessions.has(session.id)).toBe(false)
      expect(() => sessions.asset(session.id, "init.mp4")).toThrow()
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
      const invalid = sessions.create(config, resolve, signal()),
        rejection = expect(invalid).rejects.toMatchObject({
          code: "LIVE_INVALID_MEDIA",
        })
      await Promise.resolve()
      children[1].output.write(media.init)
      children[1].output.write(timedFragment(0.5, true))
      children[1].output.write(timedFragment(1.5))
      await rejection
      expect(children[1].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
      sessions.dispose()
      expect(children[0].kill).toHaveBeenCalledTimes(1)
      expect(children[1].kill).toHaveBeenCalledTimes(1)
    } finally {
      sessions.dispose()
    }
  })
  it.each([
    ["synthetic-preview.mp4", "h264"],
    ["synthetic-preview-hevc.mp4", "hevc"],
  ])(
    "retains a decodable rolling window for copied %s short fragments",
    async (name, codec) => {
      const source = copiedFragments(name)
      const { sessions, children } = setup(undefined, false)
      try {
        const pending = sessions.create(config, resolve, signal())
        await Promise.resolve()
        const output = children[0].output
        output.write(source.whole.init)
        for (const fragment of source.fragments) output.write(fragment)
        const session = await pending
        expect(session.codec).toBe(codec)
        for (let repeat = 1; repeat < 7; repeat++)
          for (const fragment of source.fragments)
            output.write(
              offsetDecodeTime(
                fragment,
                repeat * source.whole.decodeDurationSeconds,
                source.timescale
              )
            )
        const playlist = sessions.playlist(session.id),
          entries = playlistEntries(playlist),
          retained = entries.map((entry) =>
            splitFragmentedMp4(
              Buffer.concat([
                source.whole.init,
                sessions.asset(session.id, entry.asset),
              ])
            )
          )
        expect(playlist).toContain("#EXT-X-TARGETDURATION:1\n")
        expect(playlist).not.toContain("#EXT-X-INDEPENDENT-SEGMENTS")
        expect(retained[0].startsWithKeyframe).toBe(true)
        expect(retained.some((part) => !part.startsWithKeyframe)).toBe(true)
        expect(() => sessions.asset(session.id, "0.m4s")).toThrow()
        const duration = entries.reduce((sum, entry) => sum + entry.duration, 0)
        expect(duration).toBeGreaterThanOrEqual(12)
        expect(duration).toBeLessThan(12 + source.whole.decodeDurationSeconds)
        entries.forEach((entry, index) =>
          expect(entry.duration).toBeCloseTo(
            retained[index].decodeDurationSeconds,
            6
          )
        )
        expect(duration).toBeCloseTo(
          retained.at(-1)!.decodeStartSeconds +
            retained.at(-1)!.decodeDurationSeconds -
            retained[0].decodeStartSeconds,
          4
        )
      } finally {
        sessions.dispose()
      }
    }
  )
  it("reduces retained history at a keyframe under fragment-count pressure", async () => {
    const { sessions, children } = setup(undefined, false)
    try {
      const pending = sessions.create(config, resolve, signal())
      await Promise.resolve()
      const output = children[0].output
      output.write(media.init)
      for (let index = 0; index <= MAX_LIVE_SEGMENTS; index++)
        output.write(timedFragment(0.05, index === 0 || index === 100))
      const session = await pending,
        entries = playlistEntries(sessions.playlist(session.id)),
        first = splitFragmentedMp4(
          Buffer.concat([
            media.init,
            sessions.asset(session.id, entries[0].asset),
          ])
        ),
        duration = entries.reduce((sum, entry) => sum + entry.duration, 0)
      expect(entries.length).toBeLessThanOrEqual(MAX_LIVE_SEGMENTS)
      expect(first.startsWithKeyframe).toBe(true)
      expect(duration).toBeGreaterThanOrEqual(3)
      expect(duration).toBeLessThan(12)
      expect(() => sessions.asset(session.id, "0.m4s")).toThrow()
      expect(children[0].kill).not.toHaveBeenCalled()
      sessions.delete(session.id)
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
    } finally {
      sessions.dispose()
    }
  })
  it("rejects excessive dependent fragments before startup and cleans up the failed child", async () => {
    const { sessions, children } = setup(undefined, false)
    try {
      const pending = sessions.create(config, resolve, signal()),
        rejection = expect(pending).rejects.toMatchObject({
          code: "LIVE_BUFFER_LIMIT",
        })
      await Promise.resolve()
      const output = children[0].output,
        dependent = timedFragment(1 / timescale)
      output.write(media.init)
      output.write(timedFragment(1 / timescale, true))
      for (let index = 1; index < MAX_LIVE_SEGMENTS; index++)
        output.write(dependent)
      expect(children[0].kill).not.toHaveBeenCalled()
      output.write(dependent)
      await rejection
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
      const replacement = sessions.create(config, resolve, signal())
      await Promise.resolve()
      children[1].output.write(media.init)
      children[1].output.write(media.media)
      await expect(replacement).resolves.toMatchObject({ codec: "h264" })
      sessions.dispose()
      expect(
        children.every((child) => vi.mocked(child.kill).mock.calls.length === 1)
      ).toBe(true)
    } finally {
      sessions.dispose()
    }
  })
  it("parses chunk boundaries, maintains a bounded rolling playlist and cleans on delete", async () => {
    const { sessions, children } = setup(undefined, false)
    try {
      const pending = sessions.create(config, resolve, signal())
      await Promise.resolve()
      const all = Buffer.concat([media.init, media.media])
      for (let at = 0; at < all.length; at += 37)
        children[0].output.write(all.subarray(at, at + 37))
      const session = await pending
      expect(session.codec).toBe("h264")
      expect(JSON.stringify(session)).not.toMatch(/rtsp:|test-secret|nvr.test/)
      expect(sessions.asset(session.id, "init.mp4")).toEqual(media.init)
      expect(sessions.playlist(session.id)).not.toContain("ENDLIST")
      for (let index = 0; index < 10; index++)
        children[0].output.write(media.media)
      const playlist = sessions.playlist(session.id)
      expect((playlist.match(/#EXTINF/g) ?? []).length).toBe(12)
      expect(playlist).not.toContain("\n0.m4s")
      expect(() => sessions.asset(session.id, "0.m4s")).toThrow()
      expect(() => sessions.asset(session.id, "../secret")).toThrow()
      sessions.delete(session.id)
      sessions.delete(session.id)
      expect(children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
      expect(() => sessions.playlist(session.id)).toThrow()
    } finally {
      sessions.dispose()
    }
  })
  it("serves bounded copied audio with timestamps and cursor validation, and isolates audio failures", async () => {
    const { sessions, children } = setup()
    try {
      const session = await sessions.create(config, resolve, signal())
      const audioFile = readFileSync(
        new URL("../fixtures/synthetic-g711-audio.mov", import.meta.url)
      )
      expect(sessions.audio(session.id, -1).status).toBe("pending")
      for (let at = 0; at < audioFile.length; at += 71)
        children[0].audio.write(audioFile.subarray(at, at + 71))
      const result = sessions.audio(session.id, -1)
      expect(result.status).toBe("available")
      expect(result.chunks[0]).toMatchObject({
        codec: "alaw",
        sampleRate: 8000,
        channels: 1,
        startSeconds: 0,
      })
      const last = result.chunks.at(-1)!
      expect(sessions.audio(session.id, last.sequence).chunks).toHaveLength(0)
      const service = new NvrService(config)
      const app = createApp(() => service, new PreviewSessions(), sessions)
      expect(
        (await app.request(`/api/streams/${session.id}/audio?after=-1`)).status
      ).toBe(200)
      expect(
        (await app.request(`/api/streams/${session.id}/audio?after=bad`)).status
      ).toBe(400)
      children[0].audio.write(Buffer.alloc(256 * 1024 + 1))
      expect(sessions.audio(session.id, -1)).toMatchObject({
        status: "unsupported",
        chunks: [],
      })
      expect(sessions.playlist(session.id)).toContain("#EXTM3U")
      sessions.delete(session.id)
      expect(
        (await app.request(`/api/streams/${session.id}/audio`)).status
      ).toBe(404)
    } finally {
      sessions.dispose()
    }
  })
  it("caps pending and ready sessions at sixteen", async () => {
    const { sessions, children } = setup()
    try {
      for (let index = 0; index < MAX_LIVE_SESSIONS; index++)
        await sessions.create(config, resolve, signal())
      await expect(
        sessions.create(config, resolve, signal())
      ).rejects.toMatchObject({ code: "MEDIA_BUSY" })
      sessions.dispose()
      expect(
        children.every((child) => vi.mocked(child.kill).mock.calls.length === 1)
      ).toBe(true)
      await expect(
        sessions.create(config, resolve, signal())
      ).resolves.toMatchObject({ codec: "h264" })
    } finally {
      sessions.dispose()
    }
  })
  it("cleans up on cancellation, failure, malformed output and missing channel", async () => {
    const { sessions, children, launcher } = setup(undefined, false)
    try {
      await expect(
        sessions.create(
          config,
          async () => {
            throw new Error("lookup failed")
          },
          signal()
        )
      ).rejects.toThrow("lookup failed")
      expect(launcher).not.toHaveBeenCalled()
      const controller = new AbortController()
      const pending = sessions.create(config, resolve, controller.signal)
      await Promise.resolve()
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
      expect(children[0].kill).toHaveBeenCalled()
      const broken = sessions.create(config, resolve, signal())
      await Promise.resolve()
      children[1].emit("error", new Error("private RTSP data"))
      await expect(broken).rejects.toMatchObject({
        code: "MEDIA_TOOL_UNAVAILABLE",
      })
      const malformed = sessions.create(config, resolve, signal())
      await Promise.resolve()
      children[2].output.write(Buffer.alloc(8))
      await expect(malformed).rejects.toMatchObject({
        code: "LIVE_INVALID_MEDIA",
      })
    } finally {
      sessions.dispose()
    }
  })
  it("expires, reaps idle sessions and bounds startup time", async () => {
    vi.useFakeTimers()
    const first = setup(1000),
      idle = setup(),
      waiting = setup(undefined, false)
    try {
      const one = await first.sessions.create(config, resolve, signal())
      await vi.advanceTimersByTimeAsync(1001)
      expect(() => first.sessions.playlist(one.id)).toThrow()
      const two = await idle.sessions.create(config, resolve, signal())
      const pending = waiting.sessions.create(config, resolve, signal())
      const rejection = expect(pending).rejects.toMatchObject({
        code: "LIVE_TIMEOUT",
      })
      await vi.advanceTimersByTimeAsync(20_001)
      await rejection
      await vi.advanceTimersByTimeAsync(11_000)
      expect(() => idle.sessions.playlist(two.id)).toThrow()
      expect(idle.children[0].kill).toHaveBeenCalled()
    } finally {
      first.sessions.dispose()
      idle.sessions.dispose()
      waiting.sessions.dispose()
      vi.useRealTimers()
    }
  })
  it("validates channel membership and body/origin; serves opaque same-origin media", async () => {
    const { sessions, launcher } = setup()
    const service = new NvrService(config)
    vi.spyOn(service, "channels").mockResolvedValue([
      { id: "101", name: "test", configuredEnabled: false },
    ])
    const app = createApp(() => service, new PreviewSessions(), sessions)
    const post = (body: unknown, headers = {}) =>
      app.request("/api/streams/live", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    try {
      for (const body of [
        { track: "rtsp://external.test" },
        { track: "101", url: "http://external.test" },
        {},
        { track: "101", padding: "a".repeat(2000) },
      ])
        expect((await post(body)).status).toBe(400)
      expect(
        (await post({ track: "101" }, { origin: "http://external.test" }))
          .status
      ).toBe(403)
      expect((await post({ track: "201" })).status).toBe(404)
      expect(launcher).not.toHaveBeenCalled()
      const response = await post({ track: "101" }),
        session = await response.json()
      expect(response.status).toBe(201)
      expect(session.targetDurationSeconds).toBe(1)
      expect(session.startup).toEqual({
        firstByteMs: expect.any(Number),
        firstFragmentMs: expect.any(Number),
        firstIndependentFragmentMs: expect.any(Number),
        readyMs: expect.any(Number),
      })
      const playlist = await app.request(session.playlistUrl)
      expect(playlist.status).toBe(200)
      expect(playlist.headers.get("cache-control")).toBe("no-store")
      expect(
        (await app.request(`/api/streams/${session.id}/init.mp4`)).status
      ).toBe(200)
      expect(
        (await app.request(`/api/streams/${session.id}/0.m4s`)).status
      ).toBe(200)
      expect(
        (await app.request(`/api/streams/${session.id}/other`)).status
      ).toBe(404)
      expect(
        (await app.request(`/api/streams/${session.id}`, { method: "DELETE" }))
          .status
      ).toBe(204)
      expect((await app.request(session.playlistUrl)).status).toBe(404)
    } finally {
      sessions.dispose()
    }
  })
})
