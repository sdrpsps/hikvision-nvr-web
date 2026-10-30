import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { readNvrConfig } from "../server/config"
import { AppError } from "../server/errors"
import {
  openPlaybackInput,
  type PlaybackInputContext,
} from "../server/playback-input"
import type { RawSegment } from "../server/xml"

const mocks = vi.hoisted(() => ({
  forTrack: vi.fn(),
  download: vi.fn(),
  replay: vi.fn(),
}))
vi.mock("../server/playback-capabilities", () => ({
  PlaybackCapabilities: class {
    forTrack = mocks.forTrack
  },
}))
vi.mock("../server/download", () => ({ openRecordingDownload: mocks.download }))
vi.mock("../server/shttp-replay", () => ({ openShttpReplay: mocks.replay }))

const recording: RawSegment = {
  trackId: "101",
  startAt: "2026-10-28T00:00:00.000Z",
  endAt: "2026-10-28T03:00:00.000Z",
  fileRange: {
    startAt: "2026-10-28T00:00:00.000Z",
    endAt: "2026-10-28T03:00:00.000Z",
  },
  playbackURI: "rtsp://nvr.test/Streaming/tracks/101/?name=synthetic&size=123",
}
const config = () =>
  readNvrConfig({
    NVR_HOST: "nvr.test",
    NVR_USERNAME: "test",
    NVR_PASSWORD: "synthetic-only",
  })
const signal = () => new AbortController().signal
const contexts = () => ({
  recording,
  requestedAt: "2026-10-28T02:59:03.000Z",
  onReady: vi.fn<PlaybackInputContext["onReady"]>(),
})

// A tiny structural MPEG-2 PS sample exercises the production clock parser.
function clockSample(at: string) {
  const local = new Date(Date.parse(at) + 8 * 3600_000)
  const descriptor = Buffer.alloc(11)
  descriptor.set([0x40, 9, 0x48, 0x4b, 1, 0, local.getUTCFullYear() - 2000])
  descriptor.writeUInt32BE(
    (local.getUTCMonth() + 1) * 2 ** 28 +
      local.getUTCDate() * 2 ** 23 +
      local.getUTCHours() * 2 ** 18 +
      local.getUTCMinutes() * 2 ** 12 +
      local.getUTCSeconds() * 2 ** 6,
    7
  )
  const mapBody = Buffer.concat([
    Buffer.from([0xe0, 0xff, 0, descriptor.length]),
    descriptor,
    Buffer.from([0, 4, 0x24, 0xe0, 0, 0]),
    Buffer.alloc(4),
  ])
  const mapHeader = Buffer.from([0, 0, 1, 0xbc, 0, mapBody.length])
  const accessUnit = Buffer.from([
    0, 0, 1, 0x40, 1, 0x80, 0, 0, 1, 0x42, 1, 0x80, 0, 0, 1, 0x44, 1, 0x80, 0,
    0, 1, 0x26, 1, 0x80, 0, 0, 1, 0x46, 1, 0x80,
  ])
  const videoHeader = Buffer.from([
    0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1,
  ])
  videoHeader.writeUInt16BE(accessUnit.length + 8, 4)
  return Buffer.concat([
    Buffer.from([0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0, 0, 3, 0xf8]),
    mapHeader,
    mapBody,
    videoHeader,
    accessUnit,
  ])
}

function upstream(chunks: Uint8Array[], complete = true) {
  const cancel = vi.fn()
  const source = {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const bytes of chunks) controller.enqueue(bytes)
        controller.close()
      },
      cancel,
    }),
    finished: Promise.resolve({ complete }),
    close: vi.fn(),
  }
  mocks.replay.mockResolvedValue(source)
  return source
}
async function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = []
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
beforeEach(() => {
  mocks.forTrack.mockResolvedValue({ nativeChannel: 33, streamIndex: 0 })
})
afterEach(() => vi.resetAllMocks())

describe("trusted playback source adapter", () => {
  it("passes no-context callers to the untouched file download", async () => {
    const response = new Response("original")
    mocks.download.mockResolvedValue(response)
    const input = await openPlaybackInput(
      recording.playbackURI,
      config(),
      signal()
    )
    expect(await collect(input.stream)).toEqual(Buffer.from("original"))
    expect(mocks.download.mock.calls[0][0]).toBe(recording.playbackURI)
    expect(mocks.forTrack).not.toHaveBeenCalled()
    expect(mocks.replay).not.toHaveBeenCalled()
    expect(input.durationSeconds).toBeUndefined()
    input.close()
  })

  it("keeps unsupported devices on the legacy file source without guessed clock metadata", async () => {
    mocks.forTrack.mockResolvedValue(undefined)
    mocks.download.mockResolvedValue(new Response("original"))
    const context = contexts(),
      parent = signal()
    const input = await openPlaybackInput(
      recording.playbackURI,
      config(),
      parent,
      context
    )
    expect(mocks.forTrack).toHaveBeenCalledWith("101", parent)
    expect(context.onReady).not.toHaveBeenCalled()
    expect(mocks.replay).not.toHaveBeenCalled()
    expect(await collect(input.stream)).toEqual(Buffer.from("original"))
    input.close()
  })

  it("can abort a locked fallback HTTP body on close", async () => {
    mocks.download.mockResolvedValue(new Response("original"))
    const input = await openPlaybackInput(
      recording.playbackURI,
      config(),
      signal()
    )
    const requestSignal = mocks.download.mock.calls[0][2] as AbortSignal
    const reader = input.stream.getReader()
    expect(requestSignal.aborted).toBe(false)
    input.close()
    expect(requestSignal.aborted).toBe(true)
    await reader.cancel()
    reader.releaseLock()
  })

  it("preserves the sampled prefix and identifies the actual clock, never the requested second", async () => {
    const sample = clockSample("2026-10-28T02:59:00.000Z")
    const source = upstream([
      sample.subarray(0, 3),
      sample.subarray(3),
      Buffer.from("tail"),
    ])
    const context = contexts(),
      settings = config(),
      parent = signal()
    const input = await openPlaybackInput(
      recording.playbackURI,
      settings,
      parent,
      context
    )
    expect(mocks.replay).toHaveBeenCalledWith(
      settings,
      {
        nativeChannel: 33,
        streamIndex: 0,
        startAt: "2026-10-28T02:59:01.000Z",
        endAt: "2026-10-28T03:00:10.000Z",
      },
      parent
    )
    expect(context.onReady).toHaveBeenCalledExactlyOnceWith({
      source: "shttp",
      mediaStartAt: "2026-10-28T02:59:00.000Z",
      firstVideoHash: createHash("sha256")
        .update(Buffer.from([0x26, 1, 0x80]))
        .digest("hex"),
      fileDurationSeconds: 10800,
      startOffsetSeconds: 3,
      estimatedDurationSeconds: 60,
    })
    expect(input.durationSeconds).toBe(60)
    expect(await collect(input.stream)).toEqual(
      Buffer.concat([sample, Buffer.from("tail")])
    )
    expect(await input.finished).toEqual({ complete: true })
    input.close()
    expect(source.close).toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it("keeps a clipped coverage's boundary and complete-file download duration separate", async () => {
    upstream([clockSample("2026-10-28T02:59:00.000Z")])
    const context = contexts()
    context.recording = {
      ...recording,
      fileRange: {
        startAt: "2026-10-27T23:00:00.000Z",
        endAt: "2026-10-28T04:00:00.000Z",
      },
    }
    const input = await openPlaybackInput(
      recording.playbackURI,
      config(),
      signal(),
      context
    )
    expect(context.onReady.mock.calls[0][0].fileDurationSeconds).toBe(18000)
    expect(input.durationSeconds).toBe(60)
    expect(mocks.replay.mock.calls[0][1].endAt).toBe("2026-10-28T03:00:10.000Z")
    input.close()
  })

  it.each([
    "2026-10-27T23:59:58.000Z",
    "2026-10-28T02:58:32.000Z",
    "2026-10-28T02:59:05.000Z",
  ])(
    "rejects an out-of-window actual clock %s without silently falling back",
    async (actual) => {
      const source = upstream([clockSample(actual)])
      const context = contexts()
      await expect(
        openPlaybackInput(recording.playbackURI, config(), signal(), context)
      ).rejects.toMatchObject({ code: "MEDIA_CLOCK_MISMATCH" })
      expect(context.onReady).not.toHaveBeenCalled()
      expect(source.close).toHaveBeenCalled()
      expect(mocks.download).not.toHaveBeenCalled()
    }
  )

  it("rejects a clock at the exclusive segment end", async () => {
    const source = upstream([clockSample(recording.endAt)])
    const context = { ...contexts(), requestedAt: "2026-10-28T02:59:59.500Z" }
    await expect(
      openPlaybackInput(recording.playbackURI, config(), signal(), context)
    ).rejects.toMatchObject({ code: "MEDIA_CLOCK_MISMATCH" })
    expect(source.close).toHaveBeenCalled()
  })

  it.each([
    { chunks: [] },
    { chunks: [Buffer.from("not-mpeg")] },
    { chunks: [Buffer.alloc(1024 * 1024 + 1)] },
  ])(
    "rejects missing, malformed or over-limit clock prefixes",
    async ({ chunks }) => {
      const source = upstream(chunks)
      const context = contexts()
      await expect(
        openPlaybackInput(recording.playbackURI, config(), signal(), context)
      ).rejects.toMatchObject({ code: "MEDIA_CLOCK_UNCONFIRMED" })
      expect(context.onReady).not.toHaveBeenCalled()
      expect(source.close).toHaveBeenCalled()
      expect(mocks.download).not.toHaveBeenCalled()
    }
  )

  it("does not hide a capability/authentication failure behind another transport", async () => {
    mocks.forTrack.mockRejectedValue(
      new AppError("NVR_AUTH_FAILED", 502, "synthetic")
    )
    await expect(
      openPlaybackInput(recording.playbackURI, config(), signal(), contexts())
    ).rejects.toMatchObject({ code: "NVR_AUTH_FAILED" })
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.replay).not.toHaveBeenCalled()
  })

  it("does not hide a supported SHTTP failure behind a slow full-file download", async () => {
    mocks.replay.mockRejectedValue(
      new AppError("MEDIA_SHTTP_TIMEOUT", 504, "synthetic")
    )
    await expect(
      openPlaybackInput(recording.playbackURI, config(), signal(), contexts())
    ).rejects.toMatchObject({ code: "MEDIA_SHTTP_TIMEOUT" })
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it("rejects a foreign URI or unconfirmed complete-file range before opening SHTTP", async () => {
    await expect(
      openPlaybackInput(
        "rtsp://foreign.test/file",
        config(),
        signal(),
        contexts()
      )
    ).rejects.toMatchObject({ code: "NVR_UNTRUSTED_URI" })
    await expect(
      openPlaybackInput(recording.playbackURI, config(), signal(), {
        ...contexts(),
        recording: { ...recording, fileRange: undefined },
      })
    ).rejects.toMatchObject({ code: "MEDIA_CLOCK_UNCONFIRMED" })
    expect(mocks.replay).not.toHaveBeenCalled()
  })

  it("opens nothing for an already cancelled request", async () => {
    await expect(
      openPlaybackInput(
        recording.playbackURI,
        config(),
        AbortSignal.abort(),
        contexts()
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(mocks.forTrack).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.replay).not.toHaveBeenCalled()
  })

  it("closes the source if its ready consumer rejects the metadata", async () => {
    const source = upstream([clockSample("2026-10-28T02:59:00.000Z")])
    const context = contexts()
    context.onReady.mockImplementation(() => {
      throw new AppError("MEDIA_CANCELLED", 503, "synthetic")
    })
    await expect(
      openPlaybackInput(recording.playbackURI, config(), signal(), context)
    ).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
    expect(source.close).toHaveBeenCalled()
  })

  it("cancels the native source when its downstream stream is released", async () => {
    const source = upstream([clockSample("2026-10-28T02:59:00.000Z")], false)
    const input = await openPlaybackInput(
      recording.playbackURI,
      config(),
      signal(),
      contexts()
    )
    await input.stream.cancel()
    expect(source.close).toHaveBeenCalled()
    expect(await input.finished).toEqual({ complete: false })
  })
})
