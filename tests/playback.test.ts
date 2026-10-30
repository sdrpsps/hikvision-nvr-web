import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PlaybackSessions } from "../server/playback"
import {
  playbackRemuxArguments,
  type RecordingFragments,
} from "../server/playback-remux"
import { mp4Boxes, splitFragmentedMp4 } from "../server/mp4"
import { firstPlaybackFrameHash } from "../server/playback-frame-proof"
import { readNvrConfig } from "../server/config"
import { createApp } from "../server/app"
import { NvrService } from "../server/recordings"
import { AppError } from "../server/errors"
import type { RawSegment } from "../server/xml"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test",
  NVR_PASSWORD: "test-secret",
})
const source: RawSegment = {
  trackId: "101",
  startAt: "2026-10-16T16:00:00Z",
  endAt: "2026-10-16T17:00:00Z",
  playbackURI: "rtsp://nvr.test/Streaming/tracks/101/?name=synthetic&size=123",
  estimatedDurationSeconds: 3600,
}
const media = splitFragmentedMp4(
  readFileSync(new URL("../fixtures/synthetic-preview.mp4", import.meta.url))
)
function copiedPlaybackFragments(name: string, splitWithinGop = false) {
  const args = playbackRemuxArguments()
  // Use the product's complete output options and original encoded samples.
  args.splice(
    args.indexOf("-i") - 2,
    4,
    "-stream_loop",
    "2",
    "-i",
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
  )
  if (splitWithinGop)
    args[args.length - 1] = args
      .at(-1)!
      .replace(":select=v]", ":frag_duration=2000000:select=v]")
  const result = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  })
  if (result.error || result.status !== 0)
    throw new Error("Synthetic playback stream-copy fragmentation failed")
  const data = result.stdout,
    whole = splitFragmentedMp4(data),
    boxes = mp4Boxes(data)
  return boxes.flatMap((box, index) => {
    if (box.type !== "moof") return []
    const mdat = boxes[index + 1]
    if (mdat?.type !== "mdat") throw new Error("Incomplete playback fixture")
    return [
      splitFragmentedMp4(
        Buffer.concat([whole.init, data.subarray(box.start, mdat.end)])
      ),
    ]
  })
}
function decodeFragment(fragment: typeof media) {
  const result = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-v",
      "error",
      "-xerror",
      "-i",
      "pipe:0",
      "-map",
      "0:v:0",
      "-f",
      "null",
      "-",
      "-progress",
      "pipe:1",
    ],
    {
      input: Buffer.concat([fragment.init, fragment.media]),
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    }
  )
  if (result.error) throw result.error
  return {
    exitCode: result.status,
    frames: Number(
      [...result.stdout.toString().matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1] ?? 0
    ),
    errors: result.stderr.toString(),
  }
}
const stores: PlaybackSessions[] = [],
  roots: string[] = []
async function setup(
  fragments: RecordingFragments,
  options: ConstructorParameters<typeof PlaybackSessions>[1] = {}
) {
  const root = await mkdtemp(join(tmpdir(), "hikvision-playback-test-"))
  roots.push(root)
  const sessions = new PlaybackSessions(fragments, { root, ...options })
  stores.push(sessions)
  return { sessions, root }
}
const signal = () => new AbortController().signal
const resolve = async () => source
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new AppError("MEDIA_CANCELLED", 503, "已取消"))
    else
      signal.addEventListener(
        "abort",
        () => reject(new AppError("MEDIA_CANCELLED", 503, "已取消")),
        { once: true }
      )
  })
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
  vi.useRealTimers()
})

describe("full recording playback", () => {
  it("hands a selected time to the source and maps HK PTS onto the HLS decode origin", async () => {
    const hevc = splitFragmentedMp4(
      readFileSync(
        new URL("../fixtures/synthetic-preview-hevc.mp4", import.meta.url)
      )
    )
    const resolved = {
      ...source,
      fileRange: { startAt: "2026-10-16T12:49:33.000Z", endAt: source.endAt },
    }
    let selectedAt: string | undefined, uri: string | undefined
    const { sessions } = await setup(
      async function* (value, _config, signal, _audio, context) {
        uri = value
        selectedAt = context?.requestedAt
        expect(context?.recording).toBe(resolved)
        context?.onReady({
          source: "shttp",
          mediaStartAt: "2026-10-16T16:59:38.000Z",
          firstVideoHash: firstPlaybackFrameHash(hevc),
          fileDurationSeconds: 15027,
          startOffsetSeconds: 2,
          estimatedDurationSeconds: 22,
        })
        yield hevc
        await waitForAbort(signal)
      }
    )
    const session = await sessions.create(
      config,
      async () => resolved,
      signal(),
      "2026-10-16T16:59:40.000Z"
    )
    const lead = hevc.firstPresentationSeconds - hevc.decodeStartSeconds
    expect(lead).toBeGreaterThan(0)
    expect(uri).toBe(source.playbackURI)
    expect(selectedAt).toBe("2026-10-16T16:59:40.000Z")
    expect(session.source).toBe("shttp")
    expect(session.mediaStartAt).toBe(
      new Date(
        Date.parse("2026-10-16T16:59:38.000Z") - lead * 1000
      ).toISOString()
    )
    expect(session.startOffsetSeconds).toBeCloseTo(2 + lead, 6)
    expect(session.estimatedDurationSeconds).toBeCloseTo(22 + lead, 6)
    expect(session.fileRange).toEqual(resolved.fileRange)
    expect(session.fileDurationSeconds).toBe(15027)
    expect(session.codec).toBe("hevc")
    expect((await sessions.audio(session.id, -1, 0)).videoStartSeconds).toBe(
      hevc.decodeStartSeconds
    )
    expect(JSON.stringify(session)).not.toMatch(
      /playbackURI|rtsp:|nvr.test|synthetic|firstVideoHash/
    )
    expect(JSON.stringify(session)).not.toContain(firstPlaybackFrameHash(hevc))
    await sessions.delete(session.id)
  })

  it("preserves the requested HTTP offset when no server-side source metadata is published", async () => {
    const { sessions } = await setup(async function* () {
      yield media
    })
    const session = await sessions.create(
      config,
      async () => ({
        ...source,
        fileRange: { startAt: source.startAt, endAt: source.endAt },
      }),
      signal(),
      "2026-10-16T16:45:00.000Z"
    )
    expect(session.startOffsetSeconds).toBe(2700)
    expect(session).not.toHaveProperty("source")
    expect(session).not.toHaveProperty("mediaStartAt")
    await sessions.delete(session.id)
  })

  it.each(["invalid", "2026-10-16T15:59:59Z", "2026-10-16T17:00:00Z"])(
    "rejects an invalid selected time before opening media: %s",
    async (at) => {
      const opened = vi.fn()
      const { sessions, root } = await setup(async function* () {
        opened()
        yield media
      })
      await expect(
        sessions.create(config, resolve, signal(), at)
      ).rejects.toMatchObject({ code: "INVALID_PLAYBACK_TIME" })
      expect(opened).not.toHaveBeenCalled()
      expect(await readdir(root)).toEqual([])
    }
  )

  it("passes only the validated API target to the trusted recording source", async () => {
    let at: string | undefined
    const { sessions } = await setup(
      async function* (_uri, _config, signal, _audio, context) {
        at = context?.requestedAt
        yield media
        await waitForAbort(signal)
      }
    )
    const service = new NvrService(config)
    vi.spyOn(service, "resolveSegment").mockResolvedValue(source)
    const app = createApp(() => service, sessions)
    const response = await app.request("/api/streams/playback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        track: "101",
        date: "2026-10-17",
        segmentId: "a".repeat(32),
        at: "2026-10-16T16:45:00.000Z",
      }),
    })
    expect(response.status).toBe(201)
    expect(at).toBe("2026-10-16T16:45:00.000Z")
    expect(vi.mocked(service.resolveSegment).mock.calls[0][3]).toBeInstanceOf(
      AbortSignal
    )
    const result = await response.json()
    expect(JSON.stringify(result)).not.toMatch(
      /playbackURI|rtsp:|nvr.test|synthetic/
    )
    await sessions.delete(result.id)
    const bad = await app.request("/api/streams/playback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        track: "101",
        date: "2026-10-17",
        segmentId: "a".repeat(32),
        at: "not-a-date",
      }),
    })
    expect(bad.status).toBe(400)
    expect(service.resolveSegment).toHaveBeenCalledTimes(1)
  })

  it("cancels the trusted recording lookup before it can start a superseded media source", async () => {
    let lookupSignal: AbortSignal | undefined, entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const opened = vi.fn()
    const { sessions, root } = await setup(async function* () {
      opened()
      yield media
    })
    const controller = new AbortController()
    const pending = sessions.create(
      config,
      (signal) => {
        lookupSignal = signal
        entered()
        return new Promise<RawSegment>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          })
        })
      },
      controller.signal
    )
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MEDIA_CANCELLED",
    })
    await started
    controller.abort()
    await rejected
    expect(lookupSignal?.aborted).toBe(true)
    expect(opened).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
    const latest = await sessions.create(config, resolve, signal())
    expect(latest.codec).toBe("h264")
    await sessions.delete(latest.id)
  })

  it.each([false, true])(
    "rejects an unconfirmed server-seek output clock (invalid keyframe %s)",
    async (badKeyframe) => {
      const { sessions, root } = await setup(
        async function* (_uri, _config, _signal, _audio, context) {
          context?.onReady({
            source: "shttp",
            mediaStartAt: source.startAt,
            firstVideoHash: firstPlaybackFrameHash(media),
            fileDurationSeconds: 3600,
            startOffsetSeconds: 0,
            estimatedDurationSeconds: 3600,
          })
          yield {
            ...media,
            ...(badKeyframe
              ? { startsWithKeyframe: false }
              : { firstPresentationSeconds: 100 }),
          }
        }
      )
      await expect(
        sessions.create(config, resolve, signal())
      ).rejects.toMatchObject({ code: "MEDIA_CLOCK_UNCONFIRMED" })
      expect(await readdir(root)).toEqual([])
    }
  )

  it.each(["0".repeat(64), "invalid-proof"])(
    "rejects mismatched first-frame proof and cleans the session: %s",
    async (firstVideoHash) => {
      let closed = false
      const { sessions, root } = await setup(
        async function* (_uri, _config, _signal, _audio, context) {
          try {
            context?.onReady({
              source: "shttp",
              mediaStartAt: source.startAt,
              firstVideoHash,
              fileDurationSeconds: 3600,
              startOffsetSeconds: 0,
              estimatedDurationSeconds: 3600,
            })
            yield media
          } finally {
            closed = true
          }
        }
      )
      await expect(
        sessions.create(config, resolve, signal())
      ).rejects.toMatchObject({
        code: "MEDIA_CLOCK_MISMATCH",
        message: "录像封装的首帧与设备时间不符，已停止回放。",
      })
      expect(closed).toBe(true)
      expect(await readdir(root)).toEqual([])
    }
  )

  it("returns only the resolved full-file time range and selected start offset in the session", async () => {
    const { sessions } = await setup(async function* () {
      yield media
    })
    const resolved = {
      ...source,
      fileRange: { startAt: "2026-10-16T12:49:33.000Z", endAt: source.endAt },
      startOffsetSeconds: 11427,
    }
    const session = await sessions.create(
      config,
      async () => resolved,
      signal()
    )
    expect(session.fileRange).toEqual(resolved.fileRange)
    expect(session.startOffsetSeconds).toBe(11427)
    expect(JSON.stringify(session)).not.toMatch(
      /playbackURI|rtsp:|synthetic|test-secret/
    )
    await sessions.delete(session.id)
  })

  it("cleans orphaned media on the next initialization while preserving an active owner", async () => {
    const { sessions, root } = await setup(async function* () {
      yield media
    })
    const orphan = join(root, "11111111-1111-4111-8111-111111111111")
    const active = join(root, "22222222-2222-4222-8222-222222222222")
    await mkdir(orphan)
    await writeFile(join(orphan, ".owner"), "2147483647")
    await mkdir(active)
    await writeFile(join(active, ".owner"), String(process.pid))
    const session = await sessions.create(config, resolve, signal())
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await stat(active)).isDirectory()).toBe(true)
    await sessions.delete(session.id)
  })
  it("copies both video and optional audio without a duration cutoff or transcoding", () => {
    const args = playbackRemuxArguments()
    expect(args).not.toContain("-t")
    expect(args).not.toContain("-an")
    expect(args).toContain("0:a:0?")
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual([
      "-c:v",
      "copy",
    ])
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual([
      "-c:a",
      "copy",
    ])
    expect(args.at(-1)).toContain("pipe:3")
    expect(args.join(" ")).not.toMatch(/libx26| -vf | -filter/)
  })
  it.each(["synthetic-preview.mp4", "synthetic-preview-hevc.mp4"])(
    "can decode every copied %s playback fragment when opened without previous fragments",
    (name) => {
      const fragments = copiedPlaybackFragments(name)
      expect(fragments.length).toBeGreaterThan(1)
      for (const fragment of fragments) {
        expect(fragment.startsWithKeyframe).toBe(true)
        const decoded = decodeFragment(fragment)
        expect(decoded.exitCode).toBe(0)
        expect(decoded.errors).toBe("")
        expect(decoded.frames).toBe(fragment.sampleCount)
      }
    }
  )
  it("reproduces a zero-frame initial seek when a HEVC GOP is split at two seconds", () => {
    const fragments = copiedPlaybackFragments(
      "synthetic-preview-hevc.mp4",
      true
    )
    const dependent = fragments.find((fragment) => !fragment.startsWithKeyframe)
    expect(dependent).toBeDefined()
    const decoded = decodeFragment(dependent!)
    expect(decoded.frames).toBe(0)
    expect(decoded.errors).not.toBe("")
  })
  it("keeps HEVC B-frame HLS positions aligned with encoded time instead of accumulating overlapping presentation spans", async () => {
    const copied = spawnSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        fileURLToPath(
          new URL("../fixtures/synthetic-preview-hevc.mp4", import.meta.url)
        ),
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
    if (copied.error || copied.status !== 0)
      throw new Error("Synthetic HEVC stream-copy fragmentation failed")
    const whole = splitFragmentedMp4(copied.stdout)
    const boxes = mp4Boxes(copied.stdout)
    const fragments = boxes.flatMap((box, index) => {
      if (box.type !== "moof") return []
      const mdat = boxes[index + 1]
      if (mdat?.type !== "mdat") throw new Error("Incomplete HEVC fixture")
      return [
        splitFragmentedMp4(
          Buffer.concat([
            whole.init,
            copied.stdout.subarray(box.start, mdat.end),
          ])
        ),
      ]
    })
    // Prove this encoded fixture exercises the old accumulated-clock error.
    expect(fragments.length).toBeGreaterThan(3)
    expect(
      fragments.reduce((sum, part) => sum + part.durationSeconds, 0)
    ).toBeGreaterThan(whole.durationSeconds + 0.05)
    const { sessions } = await setup(async function* () {
      yield* fragments
    })
    const session = await sessions.create(config, resolve, signal())
    await vi.waitFor(() =>
      expect(sessions.status(session.id).complete).toBe(true)
    )
    const entries = [
      ...sessions
        .playlist(session.id)
        .matchAll(/#EXTINF:([\d.]+),\n(\d+\.m4s)/g),
    ]
    expect(entries).toHaveLength(fragments.length)
    let playlistPosition = 0
    for (const entry of entries) {
      const encoded = splitFragmentedMp4(
        Buffer.concat([whole.init, await sessions.asset(session.id, entry[2])])
      )
      // A seek at a playlist boundary must load that same encoded instant.
      expect(playlistPosition).toBeCloseTo(
        encoded.decodeStartSeconds - whole.decodeStartSeconds,
        5
      )
      playlistPosition += Number(entry[1])
    }
    expect(playlistPosition).toBeCloseTo(whole.decodeDurationSeconds, 5)
    expect(sessions.status(session.id).durationSeconds).toBeCloseTo(
      whole.decodeDurationSeconds,
      6
    )
    await sessions.delete(session.id)
  })
  it("starts before EOF, preserves every fragment beyond 30 seconds, and securely releases files", async () => {
    let advance!: () => void
    let finish!: () => void
    const firstGate = new Promise<void>((resolve) => {
      advance = resolve
    })
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { sessions, root } = await setup(
      async function* (_uri, _config, signal) {
        yield media
        await Promise.race([firstGate, waitForAbort(signal)])
        yield media
        await Promise.race([gate, waitForAbort(signal)])
        for (let i = 0; i < 13; i++) yield media
      }
    )
    const session = await sessions.create(config, resolve, signal())
    expect(session.durationSeconds).toBe(3)
    expect(session.estimatedDurationSeconds).toBe(3600)
    expect(session).not.toHaveProperty("totalDurationSeconds")
    expect(sessions.status(session.id)).toEqual({
      complete: false,
      durationSeconds: 3,
      estimatedDurationSeconds: 3600,
    })
    expect(sessions.playlist(session.id)).not.toContain("ENDLIST")
    expect((await stat(join(root, session.id))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, session.id, "0.m4s"))).mode & 0o777).toBe(
      0o600
    )
    advance()
    await vi.waitFor(() =>
      expect(sessions.status(session.id)).toEqual({
        complete: false,
        durationSeconds: 6,
        estimatedDurationSeconds: 3600,
      })
    )
    finish()
    await vi.waitFor(() =>
      expect(sessions.status(session.id).complete).toBe(true)
    )
    expect(sessions.status(session.id)).toEqual({
      complete: true,
      durationSeconds: 45,
      estimatedDurationSeconds: 3600,
      totalDurationSeconds: 45,
    })
    expect(sessions.playlist(session.id)).toContain("#EXT-X-ENDLIST")
    expect((sessions.playlist(session.id).match(/#EXTINF/g) ?? []).length).toBe(
      15
    )
    expect(await sessions.asset(session.id, "14.m4s")).toEqual(media.media)
    await expect(sessions.asset(session.id, "../secret")).rejects.toMatchObject(
      { code: "MEDIA_NOT_FOUND" }
    )
    await sessions.delete(session.id)
    expect(await readdir(root)).toEqual([])
    expect(() => sessions.status(session.id)).toThrow()
  })
  it("starts playback without a trusted duration estimate instead of using a clipped search span", async () => {
    const { sessions, root } = await setup(
      async function* (_uri, _config, signal) {
        yield media
        await waitForAbort(signal)
      }
    )
    const unestimated = { ...source }
    delete unestimated.estimatedDurationSeconds
    const session = await sessions.create(
      config,
      async () => unestimated,
      signal()
    )
    expect(session.durationSeconds).toBe(3)
    expect(session).not.toHaveProperty("estimatedDurationSeconds")
    expect(session).not.toHaveProperty("totalDurationSeconds")
    expect(sessions.status(session.id)).toEqual({
      complete: false,
      durationSeconds: 3,
    })
    await sessions.delete(session.id)
    expect(await readdir(root)).toEqual([])
  })
  it("bounds concurrency and cancels the producer, including during preparation", async () => {
    let cancelled = 0
    const { sessions } = await setup(async function* (_uri, _config, signal) {
      try {
        yield media
        await waitForAbort(signal)
      } finally {
        cancelled++
      }
    })
    const one = await sessions.create(config, resolve, signal())
    const two = await sessions.create(config, resolve, signal())
    await expect(
      sessions.create(config, resolve, signal())
    ).rejects.toMatchObject({ code: "MEDIA_BUSY" })
    await sessions.delete(one.id)
    expect(cancelled).toBe(1)
    await sessions.delete(two.id)
    expect(cancelled).toBe(2)
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = await setup(async function* (_uri, _config, signal) {
      entered()
      await waitForAbort(signal)
      yield media
    })
    const controller = new AbortController()
    const created = pending.sessions.create(config, resolve, controller.signal)
    const rejected = expect(created).rejects.toMatchObject({
      code: "MEDIA_CANCELLED",
    })
    await started
    controller.abort()
    await rejected
    await vi.waitFor(async () =>
      expect(await readdir(pending.root)).toEqual([])
    )
  })
  it("reports an interrupted full download as failure rather than a completed short clip", async () => {
    let fail!: () => void
    const gate = new Promise<void>((resolve) => {
      fail = resolve
    })
    const { sessions, root } = await setup(async function* () {
      yield media
      await gate
      throw new AppError("MEDIA_REMUX_FAILED", 502, "读取中断")
    })
    const session = await sessions.create(config, resolve, signal())
    fail()
    await vi.waitFor(() =>
      expect(() => sessions.status(session.id)).toThrow(
        expect.objectContaining({ code: "MEDIA_REMUX_FAILED" })
      )
    )
    await vi.waitFor(async () => expect(await readdir(root)).toEqual([]))
  })
  it("enforces output limits before writing and times out a source that never produces media", async () => {
    const limited = await setup(
      async function* () {
        yield media
      },
      { maxBytes: 1 }
    )
    await expect(
      limited.sessions.create(config, resolve, signal())
    ).rejects.toMatchObject({ code: "MEDIA_OUTPUT_LIMIT" })
    expect(await readdir(limited.root)).toEqual([])
    const slow = await setup(
      async function* (_uri, _config, signal) {
        await waitForAbort(signal)
        yield media
      },
      { startupMs: 20 }
    )
    await expect(
      slow.sessions.create(config, resolve, signal())
    ).rejects.toMatchObject({ code: "MEDIA_TIMEOUT" })
    expect(await readdir(slow.root)).toEqual([])
  })
  it.each(["ttl", "idle"] as const)(
    "expires by %s and deletes cached media",
    async (kind) => {
      const { sessions, root } = await setup(
        async function* () {
          yield media
        },
        { [kind]: 10 }
      )
      const session = await sessions.create(config, resolve, signal())
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(() => sessions.status(session.id)).toThrow(
        expect.objectContaining({ code: "MEDIA_NOT_FOUND" })
      )
      await vi.waitFor(async () => expect(await readdir(root)).toEqual([]))
    }
  )
  it("serves seekable copied audio by media time, supports rewinding, and validates all assets", async () => {
    const { sessions, root } = await setup(
      async function* (_uri, _config, _signal, onAudio) {
        for (let i = 0; i < 10; i++)
          await onAudio?.({
            codec: "alaw",
            sampleRate: 8000,
            channels: 1,
            startSeconds: i,
            data: Buffer.alloc(8000, 0xd5),
          })
        yield media
      }
    )
    const service = new NvrService(config)
    vi.spyOn(service, "resolveSegment").mockResolvedValue(source)
    const app = createApp(() => service, sessions)
    const response = await app.request("/api/streams/playback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        track: "101",
        date: "2026-10-17",
        segmentId: "a".repeat(32),
      }),
    })
    expect(response.status).toBe(201)
    const session = await response.json()
    expect(JSON.stringify(session)).not.toMatch(
      /rtsp:|nvr.test|test-secret|playbackURI/
    )
    await vi.waitFor(() =>
      expect(sessions.status(session.id).complete).toBe(true)
    )
    const audio = await (
      await app.request(`/api/streams/${session.id}/audio?after=-1&at=7`)
    ).json()
    expect(audio.status).toBe("available")
    expect(audio.chunks[0].startSeconds).toBe(6)
    const rewind = await (
      await app.request(`/api/streams/${session.id}/audio?after=-1&at=0`)
    ).json()
    expect(rewind.chunks[0].startSeconds).toBe(0)
    expect(
      (await app.request(`/api/streams/${session.id}/audio?after=-2&at=0`))
        .status
    ).toBe(400)
    expect(
      (await app.request(`/api/streams/${session.id}/audio?after=0&at=NaN`))
        .status
    ).toBe(400)
    expect(
      (await app.request(`/api/streams/${session.id}/audio-0.bin`)).status
    ).toBe(404)
    expect((await app.request(`/api/streams/${session.id}/0.m4s`)).status).toBe(
      200
    )
    expect(
      (await app.request(`/api/streams/${session.id}/status`)).status
    ).toBe(200)
    expect(
      (await app.request(`/api/streams/${session.id}`, { method: "DELETE" }))
        .status
    ).toBe(204)
    expect(await readdir(root)).toEqual([])
    expect((await app.request(session.playlistUrl)).status).toBe(404)
  })
})
