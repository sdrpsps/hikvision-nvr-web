import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MediaTransfers, MAX_TRANSFER_BUFFER_BYTES } from "../server/transfer"
import { readNvrConfig } from "../server/config"
import { AppError } from "../server/errors"
import { createApp } from "../server/app"
import { NvrService } from "../server/recordings"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "user",
  NVR_PASSWORD: "private-secret",
})
const source = async () => ({
  playbackURI: "rtsp://nvr.test/Streaming/tracks/101/?name=private-file",
})
const stores: MediaTransfers[] = []
function transfer(
  options: ConstructorParameters<typeof MediaTransfers>[0] = {}
) {
  const result = new MediaTransfers(options)
  stores.push(result)
  return result
}
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  vi.useRealTimers()
})
const g711Diagnostics =
  [
    "Input #0, rtsp, from 'rtsp://user:private-secret@nvr.test/private-file':",
    "  Stream #0:0: Video: h264, yuv420p, 640x360",
    "  Stream #0:1: Audio: pcm_alaw, 8000 Hz, mono, s16, 64 kb/s",
    "Stream mapping:",
  ].join("\n") + "\n"
function childFactory(diagnostics: string | null = g711Diagnostics) {
  const children: (ChildProcess & {
    video: PassThrough
    audio: PassThrough
    stderr: PassThrough
  })[] = []
  const launch = vi.fn<(args: string[]) => ChildProcess>(() => {
    const video = new PassThrough(),
      audio = new PassThrough(),
      stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout: video,
      video,
      audio,
      stderr,
      stdio: [null, video, stderr, audio],
      kill: vi.fn(),
    }) as unknown as (typeof children)[number]
    children.push(child)
    if (diagnostics) stderr.write(diagnostics)
    return child
  })
  return { children, launch }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function readFrame(bytes: Uint8Array | undefined) {
  expect(bytes).toBeDefined()
  const payload = bytes!.subarray(5)
  expect(new DataView(bytes!.buffer, bytes!.byteOffset).getUint32(1)).toBe(
    payload.byteLength
  )
  return {
    kind: bytes![0],
    payload,
    status:
      bytes![0] === 3 ? JSON.parse(new TextDecoder().decode(payload)) : null,
  }
}

describe("browser transfer source contracts", () => {
  it("validates source ids and same origin before opening a transfer", async () => {
    const service = new NvrService(config)
    vi.spyOn(service, "channels").mockResolvedValue([
      { id: "101", name: "入口", configuredEnabled: true },
    ])
    const raw = {
      playbackURI: "rtsp://nvr.test/Streaming/tracks/101/?name=private-file",
      trackId: "101",
      startAt: "2026-10-16T16:00:00Z",
      endAt: "2026-10-16T17:00:00Z",
    }
    const resolve = vi.spyOn(service, "resolveSegment").mockResolvedValue(raw)
    const history = vi.fn(async (_config, resolver) => {
      await resolver()
      return new Response("media")
    })
    const live = vi.fn(async (_config, resolver) => {
      await resolver()
      return new Response("media")
    })
    const app = createApp(() => service, undefined, undefined, {
      history,
      live,
    })
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {}
    ) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    const request = {
      track: "101",
      date: "2026-10-17",
      segmentId: "a".repeat(32),
    }
    expect((await post("/api/transfers/history", request)).status).toBe(200)
    expect(resolve).toHaveBeenCalledWith("101", "2026-10-17", "a".repeat(32))
    expect(
      (
        await post("/api/transfers/history", {
          ...request,
          url: "http://evil.test",
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post("/api/transfers/history", {
          ...request,
          segmentId: "../file",
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post("/api/transfers/history", request, {
          origin: "https://other.test",
        })
      ).status
    ).toBe(403)
    expect(
      (
        await post(
          "/api/transfers/live",
          { track: "101" },
          { "sec-fetch-site": "cross-site" }
        )
      ).status
    ).toBe(403)
    expect(
      (await post("/api/transfers/live", { track: "101", host: "evil.test" }))
        .status
    ).toBe(400)
    expect((await post("/api/transfers/live", { track: "201" })).status).toBe(
      404
    )
    expect((await post("/api/transfers/live", { track: "101" })).status).toBe(
      200
    )
    expect(
      (
        await post("/api/transfers/history", {
          ...request,
          unexpected: "x".repeat(1500),
        })
      ).status
    ).toBe(400)
    expect(history).toHaveBeenCalledTimes(1)
    expect(live).toHaveBeenCalledTimes(2)
  })
})

describe("history transfer without server recording", () => {
  it("reads on demand, sends no source metadata, and cancellation closes the NVR reader", async () => {
    let pulls = 0,
      cancelled = false
    let observedSignal: AbortSignal | undefined
    const raw = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++
          controller.enqueue(Uint8Array.of(1, 2, 3))
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 }
    )
    const download = vi.fn(async (_uri, _config, signal: AbortSignal) => {
      observedSignal = signal
      return new Response(raw, {
        headers: {
          "content-type": "application/octet-stream",
          "x-private-source": "private-file",
        },
      })
    })
    const store = transfer({ download })
    const response = await store.history(
      config,
      source,
      new AbortController().signal
    )
    expect(pulls).toBe(0)
    expect(response.headers.get("x-media-format")).toBe("mpeg-ps")
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    expect(JSON.stringify([...response.headers])).not.toMatch(
      /private-file|private-secret|nvr\.test/
    )
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(Uint8Array.of(1, 2, 3))
    await tick()
    expect(pulls).toBe(1)
    await reader.cancel()
    expect(cancelled).toBe(true)
    expect(observedSignal?.aborted).toBe(true)
  })

  it("does not report truncated, empty, over-limit or failed downloads as completed", async () => {
    const truncated = transfer({
      download: async () =>
        new Response(Uint8Array.of(1, 2), {
          headers: { "content-length": "3" },
        }),
    })
    const response = await truncated.history(
      config,
      source,
      new AbortController().signal
    )
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "NVR_DOWNLOAD_INTERRUPTED",
    })
    const empty = transfer({
      download: async () => new Response(new Uint8Array()),
    })
    await expect(
      (
        await empty.history(config, source, new AbortController().signal)
      ).arrayBuffer()
    ).rejects.toMatchObject({ code: "NVR_DOWNLOAD_INTERRUPTED" })
    const large = transfer({
      maxBytes: 2,
      download: async () => new Response(Uint8Array.of(1, 2, 3)),
    })
    await expect(
      (
        await large.history(config, source, new AbortController().signal)
      ).arrayBuffer()
    ).rejects.toMatchObject({ code: "MEDIA_SOURCE_LIMIT" })
    const declaredLarge = transfer({
      maxBytes: 2,
      download: async () =>
        new Response(Uint8Array.of(1, 2, 3), {
          headers: { "content-length": "3" },
        }),
    })
    await expect(
      declaredLarge.history(config, source, new AbortController().signal)
    ).rejects.toMatchObject({ code: "MEDIA_SOURCE_LIMIT" })
    const failed = transfer({
      download: async () => {
        throw new Error("rtsp://user:private-secret@nvr.test/private-file")
      },
    })
    await expect(
      failed.history(config, source, new AbortController().signal)
    ).rejects.toMatchObject({
      code: "MEDIA_TRANSFER_FAILED",
      message: "媒体传输中断，请重试。",
    })
  })

  it("bounds shared concurrency and releases the slot on cancellation, completion and authentication failure", async () => {
    const store = transfer({
      maxSessions: 1,
      download: async () => new Response(Uint8Array.of(1, 2)),
    })
    const first = await store.history(
      config,
      source,
      new AbortController().signal
    )
    await expect(
      store.history(config, source, new AbortController().signal)
    ).rejects.toMatchObject({ code: "MEDIA_BUSY" })
    await first.body!.cancel()
    const second = await store.history(
      config,
      source,
      new AbortController().signal
    )
    await second.arrayBuffer()
    const third = await store.history(
      config,
      source,
      new AbortController().signal
    )
    await third.body!.cancel()
    const auth = transfer({
      maxSessions: 1,
      download: async () => {
        throw new AppError("NVR_AUTH_FAILED", 502, "设备录像下载认证失败。")
      },
    })
    for (let i = 0; i < 2; i++)
      await expect(
        auth.history(config, source, new AbortController().signal)
      ).rejects.toMatchObject({ code: "NVR_AUTH_FAILED" })
  })

  it("cancels stalled reads and ignores a source resolved after request cancellation", async () => {
    vi.useFakeTimers()
    let cancelled = false
    const store = transfer({
      idleMs: 100,
      download: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          })
        ),
    })
    const response = await store.history(
      config,
      source,
      new AbortController().signal
    )
    const pending = response.body!.getReader().read()
    const assertion = expect(pending).rejects.toMatchObject({
      code: "MEDIA_TRANSFER_TIMEOUT",
    })
    await vi.advanceTimersByTimeAsync(110)
    await assertion
    expect(cancelled).toBe(true)
    let resolve!: (source: { playbackURI: string }) => void
    const delayed = new Promise<{ playbackURI: string }>((done) => {
      resolve = done
    })
    const download = vi.fn()
    const lateStore = transfer({ download })
    const controller = new AbortController()
    const late = lateStore.history(config, () => delayed, controller.signal)
    controller.abort()
    resolve(await source())
    await expect(late).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
    expect(download).not.toHaveBeenCalled()
  })
})

describe("live encoded media transfer", () => {
  it("frames both encoded pipes and kills the source on consumer cancellation", async () => {
    const { launch, children } = childFactory()
    const store = transfer({ launch })
    const pending = store.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    await tick()
    children[0].video.write(Buffer.from([10, 11]))
    const response = await pending
    const reader = response.body!.getReader()
    expect(response.headers.get("x-media-format")).toBe("framed-fmp4")
    expect((await reader.read()).value).toEqual(
      Uint8Array.of(1, 0, 0, 0, 2, 10, 11)
    )
    children[0].audio.write(Buffer.from([20]))
    expect((await reader.read()).value).toEqual(
      Uint8Array.of(2, 0, 0, 0, 1, 20)
    )
    await reader.cancel()
    expect(children[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
    const args = launch.mock.calls[0][0]
    expect(args.at(-1)?.split("|")[0]).toContain("frag_duration=500000")
    expect(args[args.indexOf("-loglevel") + 1]).toBe("info")
    expect(args).toContain("-nostats")
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual([
      "-c:v",
      "copy",
    ])
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual([
      "-c:a",
      "copy",
    ])
    expect(args.join(" ")).not.toMatch(/libx26| -vf | -filter|\.mkv|\.mp4/)
  })

  it("waits for source audio classification and preserves bytes received before stderr", async () => {
    const { launch, children } = childFactory(null)
    const store = transfer({ launch })
    let resolved = false
    const pending = store.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    void pending.then(() => {
      resolved = true
    })
    await tick()
    const child = children[0]
    child.audio.write(Buffer.from([20, 21]))
    child.video.write(Buffer.from([10]))
    await tick()
    expect(resolved).toBe(false)
    child.stderr.write(g711Diagnostics.slice(0, 130))
    child.stderr.write(g711Diagnostics.slice(130))
    const response = await pending
    const reader = response.body!.getReader()
    expect(readFrame((await reader.read()).value)).toMatchObject({
      kind: 1,
      payload: Uint8Array.of(10),
    })
    expect(readFrame((await reader.read()).value)).toMatchObject({
      kind: 2,
      payload: Uint8Array.of(20, 21),
    })
    child.audio.write(Buffer.from([22]))
    expect(readFrame((await reader.read()).value).payload).toEqual(
      Uint8Array.of(22)
    )
    await reader.cancel()
  })

  it.each(["aac", "adpcm_g726le", "unknown", ""])(
    "keeps video and reports %s source audio as unsupported without forwarding audio",
    async (codec) => {
      const { launch, children } = childFactory(null)
      const store = transfer({ launch })
      const pending = store.live(
        config,
        async () => "101",
        new AbortController().signal
      )
      await tick()
      const child = children[0]
      child.audio.write(Buffer.from([20]))
      child.video.write(Buffer.from([10]))
      child.stderr.write(g711Diagnostics.replace("pcm_alaw", codec))
      const response = await pending
      const reader = response.body!.getReader()
      expect(readFrame((await reader.read()).value).kind).toBe(1)
      const unsupported = readFrame((await reader.read()).value)
      expect(unsupported.status).toEqual({
        type: "audio",
        status: "unsupported",
      })
      expect(new TextDecoder().decode(unsupported.payload)).not.toMatch(
        /nvr\.test|private-secret|private-file|Stream|codec/
      )
      child.audio.write(Buffer.from([21]))
      child.video.write(Buffer.from([11]))
      expect(readFrame((await reader.read()).value)).toMatchObject({
        kind: 1,
        payload: Uint8Array.of(11),
      })
      await reader.cancel()
    }
  )

  it.each(["before", "after"])(
    "reports an audio slave failure %s source metadata while video continues",
    async (order) => {
      const { launch, children } = childFactory(null)
      const store = transfer({ launch })
      const pending = store.live(
        config,
        async () => "101",
        new AbortController().signal
      )
      await tick()
      const child = children[0]
      const failure =
        "[tee @ internal] Slave muxer #1 failed: codec unsupported, continuing with 1/2 slaves.\n"
      const metadata = g711Diagnostics
      const diagnostic =
        order === "before" ? failure + metadata : metadata + failure
      child.video.write(Buffer.from([10]))
      for (let at = 0; at < diagnostic.length; at += 13)
        child.stderr.write(diagnostic.slice(at, at + 13))
      const reader = (await pending).body!.getReader()
      expect(readFrame((await reader.read()).value).kind).toBe(1)
      expect(readFrame((await reader.read()).value).status).toEqual({
        type: "audio",
        status: "unsupported",
      })
      child.audio.write(Buffer.from([20]))
      child.stderr.write(failure)
      child.video.write(Buffer.from([11]))
      expect(readFrame((await reader.read()).value).kind).toBe(1)
      await reader.cancel()
    }
  )

  it("does not label a source without audio as unsupported when the empty audio slave fails", async () => {
    const { launch, children } = childFactory(null)
    const store = transfer({ launch })
    const pending = store.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    await tick()
    const child = children[0]
    child.stderr.write(
      [
        "Input #0, rtsp, from 'rtsp://nvr.test/private-file':",
        "  Stream #0:0: Video: h264, yuv420p, 640x360",
        "Stream mapping:",
        "[tee @ internal] Slave muxer #1 failed: no streams, continuing with 1/2 slaves.",
        "Output #0, tee:",
      ].join("\n") + "\n"
    )
    child.video.write(Buffer.from([10]))
    const reader = (await pending).body!.getReader()
    expect(readFrame((await reader.read()).value).kind).toBe(1)
    child.video.write(Buffer.from([11]))
    expect(readFrame((await reader.read()).value).kind).toBe(1)
    await reader.cancel()
  })

  it("classifies only the first input audio track and ignores output metadata", async () => {
    const { launch, children } = childFactory(null)
    const store = transfer({ launch })
    const pending = store.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    await tick()
    const child = children[0]
    child.stderr.write(
      g711Diagnostics.replace(
        "Stream mapping:",
        [
          "  Stream #0:2: Audio: aac, 48000 Hz, stereo",
          "Stream mapping:",
          "Output #0, tee:",
          "  Stream #0:1: Audio: aac, 48000 Hz, stereo",
        ].join("\n")
      )
    )
    child.video.write(Buffer.from([10]))
    const reader = (await pending).body!.getReader()
    expect(readFrame((await reader.read()).value).kind).toBe(1)
    child.audio.write(Buffer.from([20]))
    expect(readFrame((await reader.read()).value)).toMatchObject({
      kind: 2,
      payload: Uint8Array.of(20),
    })
    await reader.cancel()
  })

  it("bounds unclassified audio memory and reports missing metadata after three seconds", async () => {
    vi.useFakeTimers()
    const { launch, children } = childFactory(null)
    const store = transfer({ launch })
    const pending = store.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    await Promise.resolve()
    const child = children[0]
    child.video.write(Buffer.from([10]))
    await vi.advanceTimersByTimeAsync(2999)
    child.audio.write(Buffer.from([20]))
    await vi.advanceTimersByTimeAsync(1)
    const reader = (await pending).body!.getReader()
    expect(readFrame((await reader.read()).value).kind).toBe(1)
    expect(readFrame((await reader.read()).value).status).toEqual({
      type: "audio",
      status: "unsupported",
    })
    child.video.write(Buffer.from([11]))
    expect(readFrame((await reader.read()).value).kind).toBe(1)
    await reader.cancel()

    const overflowFactory = childFactory(null)
    const overflow = transfer({ launch: overflowFactory.launch })
    const started = overflow.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    await Promise.resolve()
    const overflowing = overflowFactory.children[0]
    overflowing.audio.write(Buffer.alloc(MAX_TRANSFER_BUFFER_BYTES))
    overflowing.audio.write(Buffer.from([1]))
    overflowing.video.write(Buffer.from([10]))
    const overflowReader = (await started).body!.getReader()
    expect(readFrame((await overflowReader.read()).value).status).toEqual({
      type: "audio",
      status: "unsupported",
    })
    expect(readFrame((await overflowReader.read()).value).kind).toBe(1)
    overflowing.audio.write(Buffer.alloc(MAX_TRANSFER_BUFFER_BYTES))
    overflowing.video.write(Buffer.from([11]))
    expect(readFrame((await overflowReader.read()).value).kind).toBe(1)
    await overflowReader.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["pcm_alaw", "g726"])(
    "classifies real FFmpeg %s startup metadata before forwarding its audio pipe",
    async (codec) => {
      // This tiny in-memory source is synthetic test data only. Real transfers
      // are read with backpressure and never buffered as a complete recording.
      const input = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          fileURLToPath(
            new URL("../fixtures/synthetic-preview.mp4", import.meta.url)
          ),
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=8000",
          "-t",
          "1",
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-c:a",
          codec,
          "-f",
          "mov",
          "-movflags",
          "+frag_keyframe+empty_moov",
          "pipe:1",
        ],
        { maxBuffer: 1024 ** 2 }
      )
      expect(input.status, input.stderr?.toString()).toBe(0)
      expect(input.stdout.byteLength).toBeLessThan(1024 ** 2)
      let diagnostics = ""
      const store = transfer({
        launch(args) {
          const from = args.indexOf("-rtsp_transport")
          const after = args.indexOf("-i") + 2
          const child = spawn(
            "ffmpeg",
            [
              ...args.slice(0, from),
              "-f",
              "mov",
              "-i",
              "pipe:0",
              ...args.slice(after),
            ],
            { stdio: ["pipe", "pipe", "pipe", "pipe"], shell: false }
          )
          child.stdin.end(input.stdout)
          child.stderr.on("data", (chunk: Buffer) => {
            diagnostics = (diagnostics + chunk.toString()).slice(-16384)
          })
          return child
        },
      })
      const response = await store.live(
        config,
        async () => "101",
        new AbortController().signal
      )
      const reader = response.body!.getReader()
      let video = 0,
        audio = 0,
        unsupported = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const frame = readFrame(next.value)
        if (frame.kind === 1) video += frame.payload.byteLength
        if (frame.kind === 2) audio += frame.payload.byteLength
        if (frame.status?.type === "audio") unsupported++
        if (frame.status)
          expect(JSON.stringify(frame.status)).not.toMatch(
            /nvr\.test|private-secret|private-file|ffmpeg|Stream #/
          )
      }
      expect(video).toBeGreaterThan(0)
      expect(unsupported, diagnostics).toBe(codec === "pcm_alaw" ? 0 : 1)
      if (codec === "pcm_alaw") expect(audio).toBeGreaterThan(0)
      else expect(audio).toBe(0)
    }
  )

  it("pauses encoded pipes under backpressure and resumes only when consumed", async () => {
    const { launch, children } = childFactory()
    const store = transfer({ launch })
    const pending = store.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    await tick()
    const child = children[0]
    child.video.write(Buffer.alloc(MAX_TRANSFER_BUFFER_BYTES))
    const response = await pending
    expect(child.video.isPaused()).toBe(true)
    expect(child.audio.isPaused()).toBe(true)
    const reader = response.body!.getReader()
    await reader.read()
    await tick()
    expect(child.video.isPaused()).toBe(false)
    await reader.cancel()
  })

  it("reports disconnects as framed errors and reaches a clean bounded time limit", async () => {
    const { launch, children } = childFactory()
    const store = transfer({ launch })
    const pending = store.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    await tick()
    children[0].video.write(Buffer.from([1]))
    const reader = (await pending).body!.getReader()
    await reader.read()
    children[0].emit("close", 1)
    const event = (await reader.read()).value!
    expect(event[0]).toBe(3)
    expect(
      JSON.parse(new TextDecoder().decode(event.subarray(5)))
    ).toMatchObject({ type: "error", code: "LIVE_INTERRUPTED" })
    expect((await reader.read()).done).toBe(true)

    vi.useFakeTimers()
    const limitFactory = childFactory()
    const bounded = transfer({ launch: limitFactory.launch, liveTtl: 100 })
    const limited = bounded.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    await Promise.resolve()
    limitFactory.children[0].video.write(Buffer.from([1]))
    const limitedReader = (await limited).body!.getReader()
    await limitedReader.read()
    await vi.advanceTimersByTimeAsync(101)
    const end = (await limitedReader.read()).value!
    expect(JSON.parse(new TextDecoder().decode(end.subarray(5)))).toEqual({
      type: "end",
      reason: "timeout",
    })
    expect((await limitedReader.read()).done).toBe(true)
    expect(limitFactory.children[0].kill).toHaveBeenCalledTimes(1)
  })

  it("cleans failed startup and parent aborts without starting a late child", async () => {
    vi.useFakeTimers()
    const { launch, children } = childFactory()
    const store = transfer({ launch, startupMs: 50, maxSessions: 1 })
    const pending = store.live(
      config,
      async () => "101",
      new AbortController().signal
    )
    const assertion = expect(pending).rejects.toMatchObject({
      code: "LIVE_TIMEOUT",
    })
    await vi.advanceTimersByTimeAsync(51)
    await assertion
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    controller.abort()
    await expect(
      store.live(config, async () => "101", controller.signal)
    ).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
    expect(launch).toHaveBeenCalledTimes(1)
  })
})
