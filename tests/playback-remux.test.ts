import { spawn, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { PassThrough, Writable } from "node:stream"
import { setImmediate as nextTurn } from "node:timers/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FragmentedMp4Demuxer } from "../lib/media-export"
import { readNvrConfig } from "../server/config"
import { AppError } from "../server/errors"
import {
  openPlaybackInput,
  type PlaybackInputContext,
} from "../server/playback-input"
import {
  playbackRemuxArguments,
  recordingFragments,
} from "../server/playback-remux"
import { splitFragmentedMp4 } from "../server/mp4"
import type { PreviewMedia } from "../server/remux"

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}))
vi.mock("../server/playback-input", () => ({ openPlaybackInput: vi.fn() }))

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test",
  NVR_PASSWORD: "test",
})
const uri = "rtsp://nvr.test/Streaming/tracks/101/?name=synthetic"
const fixture = readFileSync(
  new URL("../fixtures/synthetic-preview.mp4", import.meta.url)
)
const controller = () => new AbortController()
type Source = Awaited<ReturnType<typeof openPlaybackInput>>
type Child = EventEmitter & {
  stdin: Writable
  stdout: PassThrough
  stderr: PassThrough
  stdio: [Writable, PassThrough, PassThrough, PassThrough]
  kill: ReturnType<typeof vi.fn>
  finish: (output?: Buffer, code?: number | null) => void
}

function childProcess(
  options: {
    write?: (child: Child) => void
    end?: (child: Child) => void
  } = {}
) {
  const child = new EventEmitter() as Child
  let finished = false
  child.stdin = new Writable({
    write(_bytes, _encoding, callback) {
      callback()
      queueMicrotask(() => options.write?.(child))
    },
    final(callback) {
      callback()
      queueMicrotask(() => options.end?.(child))
    },
  })
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
  child.finish = (output = fixture, code = 0) => {
    if (finished) return
    finished = true
    child.stdout.end(output)
    child.stderr.end()
    child.stdio[3].end()
    queueMicrotask(() => child.emit("close", code))
  }
  child.kill = vi.fn(() => {
    if (finished) return true
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    child.stdio[3].destroy()
    finished = true
    queueMicrotask(() => child.emit("close", null))
    return true
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  return child
}

function source(
  options: {
    duration?: number
    open?: boolean
    complete?: boolean
    bytes?: Uint8Array
  } = {}
) {
  let streamController!: ReadableStreamDefaultController<Uint8Array>
  let settle!: (result: { complete: boolean }) => void
  const finished = new Promise<{ complete: boolean }>((resolve) => {
    settle = resolve
  })
  const close = vi.fn(() => {
    settle({ complete: false })
  })
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      streamController = c
      c.enqueue(options.bytes ?? new Uint8Array([1, 2, 3]))
      if (!options.open) {
        c.close()
        settle({ complete: options.complete ?? true })
      }
    },
    cancel() {
      close()
    },
  })
  const value: Source = {
    stream,
    ...(options.duration !== undefined
      ? { durationSeconds: options.duration, finished }
      : {}),
    close,
  }
  vi.mocked(openPlaybackInput).mockResolvedValue(value)
  return { ...value, close, streamController }
}
async function collect(
  signal = controller().signal,
  context?: PlaybackInputContext
) {
  const result: PreviewMedia[] = []
  for await (const media of recordingFragments(
    uri,
    config,
    signal,
    undefined,
    context
  ))
    result.push(media)
  return result
}
async function started() {
  for (let turn = 0; turn < 100; turn++) {
    if (vi.mocked(spawn).mock.calls.length) return
    await nextTurn()
  }
  throw new Error("synthetic FFmpeg was not started")
}

function syntheticPs(name: string) {
  const demuxer = new FragmentedMp4Demuxer()
  const packets = [
    ...demuxer.push(
      readFileSync(new URL(`../fixtures/${name}`, import.meta.url))
    ),
    ...demuxer.finish(),
  ]
  const hevc = name.includes("hevc")
  const config = Buffer.from(packets[0].video!.codecPrivate)
  const parameters: Buffer[] = []
  let offset = hevc ? 23 : 6
  const takeNal = () => {
    const length = config.readUInt16BE(offset)
    offset += 2
    parameters.push(config.subarray(offset, offset + length))
    offset += length
  }
  if (hevc) {
    for (let index = 0; index < config[22]; index++) {
      offset++
      const count = config.readUInt16BE(offset)
      offset += 2
      for (let nal = 0; nal < count; nal++) takeNal()
    }
  } else {
    for (let nal = 0; nal < (config[5] & 31); nal++) takeNal()
    const count = config[offset++]
    for (let nal = 0; nal < count; nal++) takeNal()
  }
  const stamp = (seconds: number, prefix: number) => {
    const value = Math.round((seconds + 100) * 90000)
    return Buffer.from([
      (prefix << 4) | ((Math.floor(value / 2 ** 30) & 7) << 1) | 1,
      Math.floor(value / 2 ** 22) & 255,
      ((Math.floor(value / 2 ** 15) & 127) << 1) | 1,
      Math.floor(value / 128) & 255,
      ((value & 127) << 1) | 1,
    ])
  }
  const map = Buffer.from("000001bc000ee0ff000000041be0000000000000", "hex")
  if (hevc) map[12] = 0x24
  let crc = 0xffffffff
  for (const byte of map.subarray(0, -4)) {
    crc ^= byte << 24
    for (let bit = 0; bit < 8; bit++)
      crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0)
  }
  map.writeUInt32BE(crc >>> 0, map.length - 4)
  // Preserve the fixture's real B-frame PTS/DTS. FFmpeg's MPEG mux cannot
  // faithfully generate an HEVC PS fixture, so assemble its copied PES here.
  return Buffer.concat([
    Buffer.from([0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0, 0, 3, 0xf8]),
    map,
    ...packets.map((packet) => {
      const data = Buffer.from(packet.data)
      const nals = packet.keyframe ? [...parameters] : []
      for (let at = 0; at < data.length;) {
        const length = data.readUInt32BE(at)
        at += 4
        nals.push(data.subarray(at, at + length))
        at += length
      }
      const payload = Buffer.concat(
        nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal])
      )
      const length = 13 + payload.length
      if (length > 65535) throw new Error("Synthetic PES is too large")
      return Buffer.concat([
        Buffer.from([
          0,
          0,
          1,
          0xe0,
          length >>> 8,
          length & 255,
          0x80,
          0xc0,
          10,
        ]),
        stamp(packet.pts, 3),
        stamp(packet.dts ?? packet.pts, 1),
        payload,
      ])
    }),
  ])
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe("source-aware playback remux", () => {
  it("preserves the unlimited HTTP copy-only arguments and adds only an output -t for bounded sources", () => {
    expect(playbackRemuxArguments()).not.toContain("-t")
    const args = playbackRemuxArguments(123.5)
    expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual([
      "-t",
      "123.5",
    ])
    expect(args.indexOf("-t")).toBeGreaterThan(args.indexOf("-i"))
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual([
      "-c:v",
      "copy",
    ])
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual([
      "-c:a",
      "copy",
    ])
    expect(args.join(" ")).not.toMatch(/libx26| -vf | -filter/)
    for (const invalid of [0, -1, NaN, Infinity])
      expect(() => playbackRemuxArguments(invalid)).toThrow(
        expect.objectContaining({ code: "MEDIA_INVALID_RANGE" })
      )
  })

  it("cleans the preparation deadline and preserves a safe input-open failure without spawning FFmpeg", async () => {
    vi.useFakeTimers()
    vi.mocked(openPlaybackInput).mockRejectedValue(
      new AppError("MEDIA_SHTTP_TIMEOUT", 504, "历史回放取流超时。")
    )
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_SHTTP_TIMEOUT",
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("closes an opened source when cancellation happened during its preparation", async () => {
    const current = source({ duration: 3, open: true })
    const abort = controller()
    abort.abort()
    await expect(collect(abort.signal)).rejects.toMatchObject({
      code: "MEDIA_CANCELLED",
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(current.close).toHaveBeenCalled()
    expect(current.stream.locked).toBe(false)
  })

  it("closes a prepared source if its trusted duration cannot be used", async () => {
    const current = source({ duration: NaN, open: true })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_INVALID_RANGE",
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(current.close).toHaveBeenCalled()
    expect(current.stream.locked).toBe(false)
  })

  it("forwards trusted input context and does not apply SHTTP coverage rules to HTTP", async () => {
    const current = source()
    const child = childProcess({ end: (child) => child.finish() })
    const context: PlaybackInputContext = {
      recording: {
        trackId: "101",
        startAt: "2026-10-28T00:00:00Z",
        endAt: "2026-10-28T01:00:00Z",
        playbackURI: uri,
        estimatedDurationSeconds: 3600,
      },
      requestedAt: "2026-10-28T00:59:00Z",
      onReady: vi.fn(),
    }
    const media = await collect(undefined, context)
    expect(
      media.reduce((sum, part) => sum + part.decodeDurationSeconds, 0)
    ).toBe(3)
    expect(openPlaybackInput).toHaveBeenCalledWith(
      uri,
      config,
      expect.any(AbortSignal),
      context
    )
    expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain("-t")
    expect(child.stdin.writableFinished).toBe(true)
    expect(current.close).toHaveBeenCalled()
    expect(media[0]).toEqual(
      splitFragmentedMp4(Buffer.concat([media[0].init, media[0].media]))
    )
  })

  it("accepts a complete source only when the continuous output covers its trusted duration", async () => {
    const current = source({ duration: 3 })
    childProcess({ end: (child) => child.finish() })
    const media = await collect()
    expect(media).toHaveLength(3)
    expect(
      media.reduce((sum, part) => sum + part.decodeDurationSeconds, 0)
    ).toBe(3)
    expect(vi.mocked(spawn).mock.calls[0][1]).toContain("-t")
    expect(current.close).toHaveBeenCalled()
  })

  it.each(["EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "local-close"])(
    "accepts a verified -t boundary with %s and finished:false",
    async (kind) => {
      const current = source({ duration: 3, open: true })
      let done = false
      childProcess({
        write(child) {
          if (done) return
          done = true
          if (kind === "EPIPE")
            child.stdin.destroy(
              Object.assign(new Error("synthetic sink closed"), { code: kind })
            )
          else if (kind === "ERR_STREAM_PREMATURE_CLOSE") child.stdin.destroy()
          child.finish()
        },
      })
      expect(await collect()).toHaveLength(3)
      expect(await current.finished).toEqual({ complete: false })
      expect(current.close).toHaveBeenCalled()
    }
  )

  it("does not mistake an upstream finished:false followed by natural EOF for a local -t stop", async () => {
    source({ duration: 3, complete: false })
    childProcess({ end: (child) => child.finish() })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_REMUX_FAILED",
    })
  })

  it.each([5, 1, 4.01])(
    "rejects code0 and source complete when output misses trusted duration %s",
    async (duration) => {
      const current = source({ duration })
      childProcess({ end: (child) => child.finish() })
      await expect(collect()).rejects.toMatchObject({
        code: "MEDIA_REMUX_FAILED",
      })
      expect(current.close).toHaveBeenCalled()
    }
  )

  it("uses at most one second of HK clock tolerance", async () => {
    source({ duration: 4 })
    childProcess({ end: (child) => child.finish() })
    expect(await collect()).toHaveLength(3)
  })

  it("never accepts an empty output even for a subsecond requested window", async () => {
    source({ duration: 0.5 })
    childProcess({ end: (child) => child.finish(Buffer.alloc(0)) })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_REMUX_FAILED",
    })
  })

  it("rejects decode gaps instead of counting their empty timeline as coverage", async () => {
    const gapped = Buffer.from(fixture)
    let offset = -1
    for (let index = 0; index < 3; index++)
      offset = gapped.indexOf("tfdt", offset + 1)
    expect(offset).toBeGreaterThan(0)
    if (gapped[offset + 4] === 1)
      gapped.writeBigUInt64BE(
        gapped.readBigUInt64BE(offset + 8) + BigInt(1_000_000),
        offset + 8
      )
    else
      gapped.writeUInt32BE(
        gapped.readUInt32BE(offset + 8) + 1_000_000,
        offset + 8
      )
    source({ duration: 3 })
    childProcess({ end: (child) => child.finish(gapped) })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_REMUX_FAILED",
    })
  })

  it("never hides an upstream protocol AppError behind code0 and full output coverage", async () => {
    const current = source({ duration: 3, open: true })
    let done = false
    const child = childProcess({
      write(child) {
        if (done) return
        done = true
        child.stdout.write(fixture)
        current.streamController.error(
          new AppError("MEDIA_SHTTP_DEVICE_ERROR", 502, "设备回放错误。")
        )
      },
    })
    child.kill.mockImplementation(() => {
      child.finish(Buffer.alloc(0))
      return true
    })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_SHTTP_DEVICE_ERROR",
    })
    expect(current.close).toHaveBeenCalled()
  })

  it("rejects an EPIPE originating upstream rather than at FFmpeg stdin", async () => {
    const current = source({ duration: 3, open: true })
    let done = false
    const child = childProcess({
      write(child) {
        if (done) return
        done = true
        child.stdout.write(fixture)
        current.streamController.error(
          Object.assign(new Error("private upstream failure"), {
            code: "EPIPE",
          })
        )
      },
    })
    child.kill.mockImplementation(() => {
      child.finish(Buffer.alloc(0))
      return true
    })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_REMUX_FAILED",
    })
  })

  it("still fails HTTP input errors instead of accepting incidental code0 output", async () => {
    source({ open: true })
    let done = false
    const child = childProcess({
      write(child) {
        if (done) return
        done = true
        child.stdout.write(fixture)
        child.stdin.destroy(
          Object.assign(new Error("sink closed"), { code: "EPIPE" })
        )
      },
    })
    child.kill.mockImplementation(() => {
      child.finish(Buffer.alloc(0))
      return true
    })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_REMUX_FAILED",
    })
  })

  it.each([false, true])(
    "closes the source and FFmpeg when cancelled, bounded=%s",
    async (bounded) => {
      const current = source({
        open: true,
        ...(bounded ? { duration: 3 } : {}),
      })
      const child = childProcess()
      const abort = controller()
      const pending = collect(abort.signal)
      const rejected = expect(pending).rejects.toMatchObject({
        code: "MEDIA_CANCELLED",
      })
      await started()
      abort.abort()
      await rejected
      expect(child.kill).toHaveBeenCalledWith("SIGKILL")
      expect(child.stdin.destroyed).toBe(true)
      expect(current.close).toHaveBeenCalled()
    }
  )

  it("keeps the legacy ten-minute HTTP total deadline", async () => {
    const current = source({ open: true })
    const child = childProcess()
    vi.useFakeTimers()
    const pending = collect()
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MEDIA_CANCELLED",
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await rejected
    expect(child.kill).toHaveBeenCalled()
    expect(current.close).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("removes the total deadline after SHTTP preparation while retaining caller cancellation", async () => {
    const current = source({ duration: 900, open: true })
    const child = childProcess()
    const abort = controller()
    vi.useFakeTimers()
    const pending = collect(abort.signal)
    let resolved = false
    void pending.then(
      () => {
        resolved = true
      },
      () => {
        resolved = true
      }
    )
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(resolved).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
    expect(current.close).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("runs finally cleanup if the consumer stops after its first fragment", async () => {
    const current = source({ duration: 3, open: true })
    let sent = false
    const child = childProcess({
      write(child) {
        if (!sent) {
          sent = true
          child.stdout.write(fixture)
        }
      },
    })
    for await (const media of recordingFragments(
      uri,
      config,
      controller().signal
    )) {
      expect(media.codec).toBe("h264")
      break
    }
    expect(current.close).toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalled()
    expect(child.stdin.destroyed).toBe(true)
  })

  it("preserves invalid-container and missing-tool failures with source cleanup", async () => {
    const first = source()
    childProcess({
      end: (child) =>
        child.finish(Buffer.from([0, 0, 0, 1, 109, 100, 97, 116])),
    })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_INVALID_CONTAINER",
    })
    expect(first.close).toHaveBeenCalled()
    const second = source()
    childProcess({
      end(child) {
        child.emit("error", new Error("private binary path"))
        child.finish(Buffer.alloc(0), null)
      },
    })
    await expect(collect()).rejects.toMatchObject({
      code: "MEDIA_TOOL_UNAVAILABLE",
    })
    expect(second.close).toHaveBeenCalled()
  })
})

describe("synthetic FFmpeg bounded stream copy", () => {
  it.each(["synthetic-preview.mp4", "synthetic-preview-hevc.mp4"])(
    "copies and independently decodes a guarded %s stream without transcoding",
    async (name) => {
      const { spawn: realSpawn } =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process"
        )
      vi.mocked(spawn).mockImplementation(realSpawn)
      const current = source({ duration: 2.2, bytes: syntheticPs(name) })
      const media = await collect()
      const decodeSeconds = media.reduce(
        (sum, part) => sum + part.decodeDurationSeconds,
        0
      )
      expect(Math.abs(decodeSeconds - 2.2)).toBeLessThanOrEqual(1)
      expect(media.every((part) => part.startsWithKeyframe)).toBe(true)
      for (let index = 1; index < media.length; index++)
        expect(
          Math.abs(
            media[index].decodeStartSeconds -
              media[index - 1].decodeStartSeconds -
              media[index - 1].decodeDurationSeconds
          )
        ).toBeLessThan(0.001)
      const decoded = spawnSync(
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
          input: Buffer.concat([
            media[0].init,
            ...media.map((part) => part.media),
          ]),
          maxBuffer: 1024 * 1024,
          timeout: 5000,
        }
      )
      expect(decoded.error).toBeUndefined()
      expect(decoded.status).toBe(0)
      expect(decoded.stderr.toString()).toBe("")
      const frames = Number(
        [...decoded.stdout.toString().matchAll(/^frame=(\d+)$/gm)].at(
          -1
        )?.[1] ?? 0
      )
      expect(frames).toBeGreaterThan(0)
      expect(current.close).toHaveBeenCalled()
    }
  )
})
