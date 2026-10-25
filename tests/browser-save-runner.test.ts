import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EncodedPacket } from "../lib/media-export"
import type {
  LocalWritable,
  SaveDestination,
  SaveSource,
  SaveWorkerEvent,
  SaveWorkerRequest,
} from "../lib/browser-save/types"

const fixture = readFileSync(
  new URL("../fixtures/synthetic-preview.mp4", import.meta.url)
)
const audioFixture = readFileSync(
  new URL("../fixtures/synthetic-g711-audio.mov", import.meta.url)
)

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function shifted(packets: EncodedPacket[], seconds: number) {
  return packets.map((packet) => ({
    ...packet,
    pts: packet.pts + seconds,
    dts: packet.dts === undefined ? undefined : packet.dts + seconds,
  }))
}

async function runWorker(
  source: SaveSource,
  destination: SaveDestination,
  prepare: (packets: EncodedPacket[]) => EncodedPacket[],
  unsupportedAudio = false,
  liveFrames?: Uint8Array[],
  stallAtEnd?: (controller: ReadableStreamDefaultController<Uint8Array>) => void
) {
  const { FragmentedMp4Demuxer, MpegPsDemuxer } =
    await import("../lib/media-export")
  const packets = prepare(new FragmentedMp4Demuxer().push(fixture))
  const posted: SaveWorkerEvent[] = []
  let resolveDone!: (event: SaveWorkerEvent) => void
  const done = new Promise<SaveWorkerEvent>((resolve) => {
    resolveDone = resolve
  })
  const workerScope: {
    onmessage: ((event: MessageEvent<SaveWorkerRequest>) => void) | null
    postMessage(event: SaveWorkerEvent): void
  } = {
    onmessage: null,
    postMessage(event) {
      posted.push(event)
      if (event.type === "done") resolveDone(event)
    },
  }
  vi.stubGlobal("self", workerScope)
  // Substitute the transport decoder output, while exercising the real worker,
  // selection, muxer, writer, finalization and error handling.
  if (source.mode === "history") {
    vi.spyOn(MpegPsDemuxer.prototype, "push").mockImplementation(function (
      this: InstanceType<typeof MpegPsDemuxer>
    ) {
      this.audioUnsupported = unsupportedAudio
      return packets
    })
    vi.spyOn(MpegPsDemuxer.prototype, "finish").mockReturnValue([])
  } else if (!liveFrames) {
    vi.spyOn(FragmentedMp4Demuxer.prototype, "push").mockReturnValue(packets)
  }
  const fetch = vi.fn(
    async (_input: unknown, init?: RequestInit) =>
      new Response(
        liveFrames
          ? new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  init?.signal?.addEventListener(
                    "abort",
                    () => {
                      controller.error(
                        new DOMException(
                          "Synthetic source aborted",
                          "AbortError"
                        )
                      )
                    },
                    { once: true }
                  )
                },
                pull(controller) {
                  const frame = liveFrames.shift()
                  if (frame) controller.enqueue(frame)
                  else if (stallAtEnd) stallAtEnd(controller)
                  else controller.close()
                },
              },
              { highWaterMark: 0 }
            )
          : source.mode === "history"
            ? new Uint8Array([1])
            : new Uint8Array([1, 0, 0, 0, 1, 0])
      )
  )
  vi.stubGlobal("fetch", fetch)
  await import("../lib/browser-save/runner.worker")
  workerScope.onmessage!({
    data: {
      type: "start",
      id: "synthetic-regression",
      filename: "synthetic.mkv",
      source,
      destination,
    },
  } as MessageEvent<SaveWorkerRequest>)
  const result = await done
  // Let the worker's finally block cancel its synthetic reader before globals
  // are restored for the next independent worker instance.
  await Promise.resolve()
  await Promise.resolve()
  return { result: result.patch, posted, fetch }
}

function mediaTool(name: string, args: string[]) {
  const result = spawnSync(name, args, { maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0)
    throw new Error(`${name}: ${result.stderr.toString()}`)
  return result.stdout
}

async function liveTrackFrames(audio: boolean) {
  const { FragmentedMp4Demuxer } = await import("../lib/media-export")
  const bytes = mediaTool("ffmpeg", [
    "-v",
    "error",
    "-stream_loop",
    "101",
    "-i",
    new URL(
      audio
        ? "../fixtures/synthetic-g711-audio.mov"
        : "../fixtures/synthetic-preview.mp4",
      import.meta.url
    ).pathname,
    "-t",
    "303.5",
    ...(audio ? ["-vn", "-c:a", "copy"] : ["-an", "-c:v", "copy"]),
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration",
    "500000",
    "-f",
    audio ? "mov" : "mp4",
    "pipe:1",
  ])
  const kind = audio ? 2 : 1
  const parser = new FragmentedMp4Demuxer()
  const init: Buffer[] = []
  const fragments: { kind: number; bytes: Uint8Array; end: number }[] = []
  const sourcePackets: EncodedPacket[] = []
  let moof: Buffer | undefined
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32BE(at)
    const type = bytes.toString("ascii", at + 4, at + 8)
    if (size < 8 || at + size > bytes.length)
      throw new Error("Invalid synthetic MP4 box")
    const box = bytes.subarray(at, at + size)
    if (type === "moof") moof = box
    else if (type === "mdat") {
      if (!moof) throw new Error("Synthetic MP4 fragment has no moof")
      const fragment = Buffer.concat([moof, box])
      const packets = parser.push(fragment)
      sourcePackets.push(...packets)
      fragments.push({
        kind,
        bytes: fragment,
        end: Math.max(
          ...packets.map((packet) => packet.pts + (packet.duration ?? 0))
        ),
      })
      moof = undefined
    } else if (!fragments.length) {
      init.push(box)
      parser.push(box)
    }
    at += size
  }
  return { kind, init: Buffer.concat(init), fragments, packets: sourcePackets }
}

function framed(kind: number, bytes: Uint8Array) {
  const frame = new Uint8Array(bytes.length + 5)
  frame[0] = kind
  new DataView(frame.buffer).setUint32(1, bytes.length)
  frame.set(bytes, 5)
  return frame
}

function capturedDirectory() {
  const files: { name: string; bytes: Uint8Array }[] = []
  const destination: SaveDestination = {
    type: "directory",
    directory: {
      name: "Synthetic directory",
      async getFileHandle(name) {
        let data = new Uint8Array(1024),
          position = 0,
          length = 0
        return {
          name,
          async createWritable() {
            return {
              async write(chunk) {
                if (!(chunk instanceof Uint8Array)) {
                  position = chunk.position
                  return
                }
                if (position + chunk.length > data.length) {
                  const next = new Uint8Array(
                    Math.max(data.length * 2, position + chunk.length)
                  )
                  next.set(data)
                  data = next
                }
                data.set(chunk, position)
                position += chunk.length
                length = Math.max(length, position)
              },
              async seek(value) {
                position = value
              },
              async close() {
                files.push({ name, bytes: data.slice(0, length) })
              },
              async abort() {},
            }
          },
        }
      },
    },
  }
  return { files, destination }
}

async function audioCoverage(bytes: Uint8Array) {
  const root = await mkdtemp(
    join(tmpdir(), "hikvision-runner-audio-synthetic-")
  )
  try {
    const path = join(root, "synthetic.mkv")
    await writeFile(path, bytes)
    const packets = JSON.parse(
      mediaTool("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_packets",
        "-show_entries",
        "packet=pts_time,duration_time,size",
        "-of",
        "json",
        path,
      ]).toString()
    ).packets as { pts_time: string; duration_time: string; size: string }[]
    let samples = 0,
      end = 0,
      maxGap = 0,
      maxOverlap = 0
    for (const packet of packets) {
      const start = Number(packet.pts_time)
      const duration = Number(packet.duration_time)
      maxGap = Math.max(maxGap, start - end)
      maxOverlap = Math.max(maxOverlap, end - start)
      end = start + duration
      samples += Number(packet.size)
    }
    return {
      samples,
      start: Number(packets[0]?.pts_time),
      end,
      maxGap,
      maxOverlap,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("browser save worker coverage and committed files", () => {
  it("acknowledges startup and installs its download writer before requesting credit", async () => {
    const channel = new MessageChannel()
    let ready = false
    let bytes = 0
    let chunks = 0
    channel.port2.onmessage = (event) => {
      if (event.data.type === "writer-ready") {
        ready = true
        channel.port2.postMessage({ type: "pull" })
      } else if (event.data.type === "chunk") {
        expect(ready).toBe(true)
        chunks++
        bytes += event.data.bytes.byteLength
        channel.port2.postMessage({
          type: "ack",
          sequence: event.data.sequence,
        })
        channel.port2.postMessage({ type: "pull" })
      } else if (event.data.type === "close") {
        channel.port2.postMessage({ type: "closed" })
      }
    }
    try {
      const { result, posted } = await runWorker(
        {
          mode: "history",
          track: "101",
          date: "2026-10-17",
          segmentId: "synthetic",
          channelName: "Synthetic camera",
          startSeconds: 0,
          endSeconds: 3,
        },
        { type: "download", port: channel.port1 },
        (packets) => packets
      )
      expect(posted[0]).toEqual({ type: "ready", patch: {} })
      expect(ready).toBe(true)
      expect(result.state).toBe("complete")
      expect(chunks).toBeGreaterThan(0)
      expect(result.bytes).toBe(bytes)
    } finally {
      channel.port1.close()
      channel.port2.close()
    }
  })

  it.each([
    { order: "ahead", limitSeconds: 303 },
    { order: "late", limitSeconds: 303 },
    { order: "ahead", limitSeconds: 300 },
    { order: "late", limitSeconds: 300 },
  ] as const)(
    "retains G.711 samples through rotation and limit=$limitSeconds with audio $order",
    async ({ order, limitSeconds }) => {
      // Real separated fMP4/MOV fragments exercise both transport demuxers,
      // the worker's selection/rotation and the final MKV bytes. Only the
      // synthetic network response and local destination are substituted.
      const video = await liveTrackFrames(false)
      const audio = await liveTrackFrames(true)
      const availableSamples = audio.packets.reduce(
        (total, packet) =>
          total +
          Math.max(
            0,
            Math.min(
              limitSeconds * 8000,
              Math.round((packet.pts + packet.duration!) * 8000)
            ) - Math.max(0, Math.round(packet.pts * 8000))
          ),
        0
      )
      expect(availableSamples).toBe(limitSeconds * 8000)
      const scheduled = [...video.fragments, ...audio.fragments].sort(
        (a, b) =>
          a.end +
          (a.kind === 2 ? (order === "ahead" ? -0.75 : 0.75) : 0) -
          (b.end + (b.kind === 2 ? (order === "ahead" ? -0.75 : 0.75) : 0))
      )
      const frames = [
        framed(1, video.init),
        framed(2, audio.init),
        ...scheduled.map((fragment) => framed(fragment.kind, fragment.bytes)),
      ]
      const { files, destination } = capturedDirectory()
      const { result } = await runWorker(
        {
          mode: "live",
          track: "101",
          channelName: "Synthetic camera",
          limitSeconds,
        },
        destination,
        (packets) => packets,
        false,
        frames
      )
      expect(result.state).toBe("complete")
      const lengths = limitSeconds === 300 ? [300] : [300, 3]
      expect(files).toHaveLength(lengths.length)
      const coverage = await Promise.all(
        files.map((file) => audioCoverage(file.bytes))
      )
      const report = JSON.stringify({
        order,
        limitSeconds,
        state: result.state,
        coverage,
      })
      for (const [index, seconds] of lengths.entries()) {
        expect.soft(coverage[index].samples, report).toBe(seconds * 8000)
        expect.soft(coverage[index].start, report).toBeCloseTo(0, 3)
        expect.soft(coverage[index].end, report).toBeCloseTo(seconds, 3)
        expect.soft(coverage[index].maxGap, report).toBeLessThanOrEqual(0.002)
        expect
          .soft(coverage[index].maxOverlap, report)
          .toBeLessThanOrEqual(0.002)
      }
      if (coverage.length === 2)
        expect
          .soft(Math.abs(300 + coverage[1].start - coverage[0].end), report)
          .toBeLessThanOrEqual(0.002)
    },
    30_000
  )

  it("waits for late audio at the historical keyframe end instead of cutting its tail", async () => {
    const { files, destination } = capturedDirectory()
    const { result } = await runWorker(
      {
        mode: "history",
        track: "101",
        channelName: "Synthetic camera",
        date: "2026-10-17",
        segmentId: "a".repeat(32),
        startSeconds: 0,
        endSeconds: 2.5,
      },
      destination,
      (video) => [
        ...video,
        { ...video[0], pts: 3, dts: 3 },
        {
          kind: "audio",
          codec: "alaw",
          pts: 0,
          duration: 3,
          keyframe: true,
          data: new Uint8Array(24000).fill(0xd5),
          audio: { codec: "alaw", sampleRate: 8000, channels: 1 },
        },
      ]
    )
    expect(result.state).toBe("complete")
    expect(files).toHaveLength(1)
    expect(await audioCoverage(files[0].bytes)).toEqual({
      samples: 24000,
      start: 0,
      end: 3,
      maxGap: 0,
      maxOverlap: 0,
    })
  })

  it("reports the committed media end when a later video packet is rejected", async () => {
    const { destination } = capturedDirectory()
    const { result } = await runWorker(
      {
        mode: "history",
        track: "101",
        channelName: "Synthetic camera",
        date: "2026-10-17",
        segmentId: "a".repeat(32),
        startSeconds: 0,
        endSeconds: 4,
      },
      destination,
      (video) => [
        {
          kind: "audio",
          codec: "alaw",
          pts: 0,
          duration: 3,
          keyframe: true,
          data: new Uint8Array(24000).fill(0xd5),
          audio: { codec: "alaw", sampleRate: 8000, channels: 1 },
        },
        ...video,
        {
          ...video[0],
          pts: 3,
          dts: 3,
          video: { ...video[0].video!, width: video[0].video!.width + 16 },
        },
      ]
    )
    expect(result.state).toBe("partial")
    expect(result.files).toBe(1)
    expect(result.actualEndSeconds).toBeCloseTo(3, 3)
    expect(result.durationSeconds).toBeCloseTo(3, 3)
    expect(result.message).toContain("视频编码发生变化")
  })

  it("bounds the wait for missing tail audio and retains a partial file", async () => {
    const video = await liveTrackFrames(false)
    const audio = await liveTrackFrames(true)
    const fragments = [
      ...video.fragments.filter((fragment) => fragment.end <= 3.5),
      ...audio.fragments.filter((fragment) => fragment.end <= 1.025),
    ].sort((a, b) => a.end - b.end)
    const frames = [
      framed(1, video.init),
      framed(2, audio.init),
      ...fragments.map((fragment) => framed(fragment.kind, fragment.bytes)),
    ]
    const { files, destination } = capturedDirectory()
    let stalled!: () => void
    const waiting = new Promise<void>((resolve) => {
      stalled = resolve
    })
    vi.useFakeTimers()
    const completion = runWorker(
      {
        mode: "live",
        track: "101",
        channelName: "Synthetic camera",
        limitSeconds: 3,
      },
      destination,
      (packets) => packets,
      false,
      frames,
      stalled
    )
    await waiting
    await vi.advanceTimersByTimeAsync(3001)
    const { result } = await completion
    expect(result.state).toBe("partial")
    expect(result.message).toContain("等待音轨覆盖边界超时")
    expect(result.message).toContain("音轨未覆盖完整")
    expect(files).toHaveLength(1)
    const coverage = await audioCoverage(files[0].bytes)
    expect(coverage.samples).toBe(8192)
    expect(coverage.end).toBeCloseTo(1.024, 3)
  }, 10_000)

  it("keeps received video when manually stopped while waiting for rotation audio", async () => {
    const video = await liveTrackFrames(false)
    const audio = await liveTrackFrames(true)
    const fragments = [
      ...video.fragments.filter((fragment) => fragment.end <= 300.5),
      ...audio.fragments.filter((fragment) => fragment.end <= 299.5),
    ].sort(
      (a, b) =>
        a.end + (a.kind === 2 ? 0.75 : 0) - (b.end + (b.kind === 2 ? 0.75 : 0))
    )
    const frames = [
      framed(1, video.init),
      framed(2, audio.init),
      ...fragments.map((fragment) => framed(fragment.kind, fragment.bytes)),
    ]
    const { files, destination } = capturedDirectory()
    let stalled!: () => void
    const waiting = new Promise<void>((resolve) => {
      stalled = resolve
    })
    vi.useFakeTimers()
    const completion = runWorker(
      {
        mode: "live",
        track: "101",
        channelName: "Synthetic camera",
        limitSeconds: 1800,
      },
      destination,
      (packets) => packets,
      false,
      frames,
      stalled
    )
    await waiting
    const scope = self as unknown as {
      onmessage(event: MessageEvent<SaveWorkerRequest>): void
    }
    scope.onmessage({
      data: { type: "stop" },
    } as MessageEvent<SaveWorkerRequest>)
    await vi.advanceTimersByTimeAsync(3001)
    const { result } = await completion
    expect(result.state).toBe("partial")
    expect(result.message).toContain("已保留")
    expect(result.message).toContain("音轨未覆盖完整")
    expect(files).toHaveLength(2)
    expect(result.actualEndSeconds).toBeCloseTo(300.5, 1)
  })

  it("drains late audio after manual stop without accepting later video or reverting stopping", async () => {
    const video = await liveTrackFrames(false)
    const audio = await liveTrackFrames(true)
    const initial = [
      ...video.fragments.filter((fragment) => fragment.end <= 3),
      audio.fragments[0],
    ].sort((a, b) => a.end - b.end)
    const frames = [
      framed(1, video.init),
      framed(2, audio.init),
      ...initial.map((fragment) => framed(fragment.kind, fragment.bytes)),
    ]
    const { files, destination } = capturedDirectory()
    let sourceController!: ReadableStreamDefaultController<Uint8Array>
    let ready!: () => void
    const waiting = new Promise<void>((resolve) => {
      ready = resolve
    })
    const completion = runWorker(
      {
        mode: "live",
        track: "101",
        channelName: "Synthetic camera",
        limitSeconds: 1800,
      },
      destination,
      (packets) => packets,
      false,
      frames,
      (controller) => {
        sourceController = controller
        ready()
      }
    )
    await waiting
    const scope = self as unknown as {
      onmessage(event: MessageEvent<SaveWorkerRequest>): void
    }
    scope.onmessage({
      data: { type: "stop" },
    } as MessageEvent<SaveWorkerRequest>)
    // Both a new video fragment and the missing audio arrive after stop.
    // Only audio for the already accepted three seconds may be saved.
    sourceController.enqueue(
      framed(1, video.fragments.find((fragment) => fragment.end > 3)!.bytes)
    )
    for (const fragment of audio.fragments
      .slice(1)
      .filter((fragment) => fragment.end <= 3.2))
      sourceController.enqueue(framed(2, fragment.bytes))
    const { result, posted } = await completion
    expect(result.state, JSON.stringify(result)).toBe("complete")
    expect(result.actualEndSeconds).toBeCloseTo(3, 3)
    expect(files).toHaveLength(1)
    const coverage = await audioCoverage(files[0].bytes)
    expect(coverage.samples).toBe(24000)
    expect(coverage.end).toBeCloseTo(3, 3)
    const stopping = posted.findIndex(
      (event) => event.patch.state === "stopping"
    )
    expect(stopping).toBeGreaterThanOrEqual(0)
    expect(
      posted
        .slice(stopping)
        .filter((event) => event.type === "progress")
        .every((event) => event.patch.state === "stopping")
    ).toBe(true)
  })

  it.each([true, false])(
    "keeps historical early-stop semantics with saved video=%s",
    async (hasVideo) => {
      const { destination } = capturedDirectory()
      let ready!: () => void
      const waiting = new Promise<void>((resolve) => {
        ready = resolve
      })
      const completion = runWorker(
        {
          mode: "history",
          track: "101",
          channelName: "Synthetic camera",
          date: "2026-10-17",
          segmentId: "a".repeat(32),
          startSeconds: 0,
          endSeconds: 100,
        },
        destination,
        (packets) => (hasVideo ? packets : []),
        false,
        [new Uint8Array([1])],
        ready
      )
      await waiting
      const scope = self as unknown as {
        onmessage(event: MessageEvent<SaveWorkerRequest>): void
      }
      scope.onmessage({
        data: { type: "stop" },
      } as MessageEvent<SaveWorkerRequest>)
      const { result } = await completion
      expect(result.state).toBe(hasVideo ? "partial" : "cancelled")
      expect(result.files).toBe(hasVideo ? 1 : 0)
    }
  )

  it("keeps decodable video and warns when the source audio track cannot be saved", async () => {
    const close = vi.fn(async () => {})
    const { result } = await runWorker(
      {
        mode: "history",
        track: "101",
        channelName: "Synthetic camera",
        date: "2026-10-17",
        segmentId: "a".repeat(32),
        startSeconds: 0,
        endSeconds: 2,
      },
      {
        type: "file",
        file: {
          name: "synthetic.mkv",
          createWritable: async () => ({ write: async () => {}, close }),
        },
      },
      (packets) => packets,
      true
    )
    expect(result.state).toBe("partial")
    expect(result.files).toBe(1)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.audioPackets).toBe(0)
    expect(result.message).toContain("音轨未保存")
    expect(result.message).toContain("已保留可用视频")
    expect(close).toHaveBeenCalledOnce()
  })

  it("keeps live video and reports partial when the bridge marks audio unsupported", async () => {
    const video = await liveTrackFrames(false)
    const frames = [
      framed(
        3,
        new TextEncoder().encode(
          JSON.stringify({ type: "audio", status: "unsupported" })
        )
      ),
      framed(1, video.init),
      ...video.fragments
        .filter((fragment) => fragment.end <= 3.5)
        .map((fragment) => framed(1, fragment.bytes)),
    ]
    const { files, destination } = capturedDirectory()
    const { result } = await runWorker(
      {
        mode: "live",
        track: "101",
        channelName: "Synthetic camera",
        limitSeconds: 3,
      },
      destination,
      (packets) => packets,
      false,
      frames
    )
    expect(result.state).toBe("partial")
    expect(result.audioPackets).toBe(0)
    expect(result.message).toContain("源音轨编码暂不支持")
    expect(files).toHaveLength(1)
    expect(result.actualEndSeconds).toBeCloseTo(3, 3)
    expect(result.bytes).toBeGreaterThan(0)
  })

  it("retains a partial recording when the bridge timeout ends it before its limit", async () => {
    const { files, destination } = capturedDirectory()
    const { result } = await runWorker(
      {
        mode: "live",
        track: "101",
        channelName: "Synthetic camera",
        limitSeconds: 1800,
      },
      destination,
      (packets) => packets,
      false,
      [
        framed(1, fixture),
        framed(2, audioFixture),
        framed(
          3,
          new TextEncoder().encode(
            JSON.stringify({ type: "end", reason: "timeout" })
          )
        ),
      ]
    )
    expect(result.state).toBe("partial")
    expect(result.message).toContain("最长时限")
    expect(result.message).not.toContain("音轨未覆盖完整")
    expect(files).toHaveLength(1)
    expect(result.actualEndSeconds).toBeCloseTo(3, 3)
    expect((await audioCoverage(files[0].bytes)).samples).toBe(24000)
  })

  it("reports failure when the bridge times out before any video is saved", async () => {
    const { files, destination } = capturedDirectory()
    const { result } = await runWorker(
      {
        mode: "live",
        track: "101",
        channelName: "Synthetic camera",
        limitSeconds: 1800,
      },
      destination,
      (packets) => packets,
      false,
      [
        framed(
          3,
          new TextEncoder().encode(
            JSON.stringify({ type: "end", reason: "timeout" })
          )
        ),
      ]
    )
    expect(result.state).toBe("failed")
    expect(result.message).toContain("最长时限")
    expect(result.files).toBe(0)
    expect(files).toHaveLength(0)
  })

  it("keeps completion when the limit keyframe and bridge timeout share a network chunk", async () => {
    const video = await liveTrackFrames(false)
    const finalChunk = Buffer.concat([
      framed(1, video.fragments.find((fragment) => fragment.end > 3)!.bytes),
      framed(
        3,
        new TextEncoder().encode(
          JSON.stringify({ type: "end", reason: "timeout" })
        )
      ),
    ])
    const { files, destination } = capturedDirectory()
    const { result } = await runWorker(
      {
        mode: "live",
        track: "101",
        channelName: "Synthetic camera",
        limitSeconds: 3,
      },
      destination,
      (packets) => packets,
      false,
      [
        framed(2, audioFixture),
        framed(1, video.init),
        ...video.fragments
          .filter((fragment) => fragment.end <= 3)
          .map((fragment) => framed(1, fragment.bytes)),
        finalChunk,
      ]
    )
    expect(result.state).toBe("complete")
    expect(result.message).not.toContain("最长时限")
    expect(result.actualEndSeconds).toBeCloseTo(3, 3)
    expect(files).toHaveLength(1)
    expect((await audioCoverage(files[0].bytes)).samples).toBe(24000)
  })

  it("reports partial coverage when the first decodable keyframe follows the selected start", async () => {
    const close = vi.fn(async () => {})
    const writable: LocalWritable = {
      write: async () => {},
      close,
      abort: async () => {},
    }
    const { result } = await runWorker(
      {
        mode: "history",
        track: "101",
        channelName: "Synthetic camera",
        date: "2026-10-17",
        segmentId: "a".repeat(32),
        startSeconds: 0,
        endSeconds: 4.5,
      },
      {
        type: "file",
        file: { name: "synthetic.mkv", createWritable: async () => writable },
      },
      (packets) => [
        ...packets.slice(1),
        ...shifted(packets, 3),
        ...shifted(packets, 6),
      ]
    )
    expect(result.state).toBe("partial")
    expect(result.actualStartSeconds).toBeGreaterThan(2)
    expect(result.actualEndSeconds).toBeGreaterThanOrEqual(4.5)
    expect(result.message).toContain("开头缺少可解码关键帧")
    expect(result.files).toBe(1)
    expect(close).toHaveBeenCalledOnce()
  })

  it("keeps the committed first segment and removes a failed second segment", async () => {
    const outputs: {
      name: string
      bytes: number
      close: ReturnType<typeof vi.fn>
      abort: ReturnType<typeof vi.fn>
    }[] = []
    const removeEntry = vi.fn(async () => {})
    const { result } = await runWorker(
      {
        mode: "live",
        track: "101",
        channelName: "Synthetic camera",
        limitSeconds: 1800,
      },
      {
        type: "directory",
        directory: {
          name: "Synthetic directory",
          removeEntry,
          async getFileHandle(name) {
            const index = outputs.length
            const output = {
              name,
              bytes: 0,
              close: vi.fn(async () => {}),
              abort: vi.fn(async () => {}),
            }
            outputs.push(output)
            return {
              name,
              async createWritable() {
                return {
                  async write(bytes) {
                    if (index > 0)
                      throw new DOMException(
                        "Synthetic disk full",
                        "QuotaExceededError"
                      )
                    if (bytes instanceof Uint8Array)
                      output.bytes += bytes.byteLength
                  },
                  close: output.close,
                  abort: output.abort,
                }
              },
            }
          },
        },
      },
      (packets) => [
        ...packets,
        ...shifted(packets, 300),
        ...shifted(packets, 600),
      ]
    )
    expect(outputs).toHaveLength(2)
    expect(outputs[0].close).toHaveBeenCalledOnce()
    expect(outputs[0].abort).not.toHaveBeenCalled()
    expect(outputs[1].close).not.toHaveBeenCalled()
    expect(outputs[1].abort).toHaveBeenCalledOnce()
    expect(removeEntry).toHaveBeenCalledExactlyOnceWith("synthetic_002.mkv")
    expect(result.state).toBe("partial")
    expect(result.files).toBe(1)
    expect(result.bytes).toBe(outputs[0].bytes)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.durationSeconds).toBeCloseTo(3, 1)
    expect(result.actualEndSeconds).toBeLessThan(4)
    expect(result.message).toContain("已保留有效部分")
    expect(result.message).toContain("Synthetic disk full")
  })
})
