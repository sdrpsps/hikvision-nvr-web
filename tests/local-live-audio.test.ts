import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LocalLiveAudio, type AudioLoader } from "../lib/live-audio"

vi.mock("@/lib/g711", async () => import("../lib/g711"))

type AudioResult = Awaited<ReturnType<AudioLoader>>
type AudioChunk = AudioResult["chunks"][number]

class SyntheticBuffer {
  readonly duration: number
  private channels: Float32Array[]

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number
  ) {
    this.duration = length / sampleRate
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length)
    )
  }

  getChannelData(channel: number) {
    return this.channels[channel]
  }
}

class SyntheticSource {
  buffer: SyntheticBuffer | null = null
  playbackRate = { value: 1 }
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn<(when?: number, offset?: number) => void>()
  stop = vi.fn()
}

class SyntheticContext {
  static instances: SyntheticContext[] = []
  state = "suspended"
  currentTime = 50
  destination = {}
  sources: SyntheticSource[] = []
  resume = vi.fn(async () => {
    this.state = "running"
  })
  close = vi.fn(async () => {
    this.state = "closed"
  })

  constructor() {
    SyntheticContext.instances.push(this)
  }

  createBuffer(channels: number, length: number, rate: number) {
    return new SyntheticBuffer(channels, length, rate)
  }

  createBufferSource() {
    const source = new SyntheticSource()
    this.sources.push(source)
    return source
  }
}

class SyntheticVideo extends EventTarget {
  currentTime = 0
  playbackRate = 1
  paused = false
  seeking = false
  readyState = 4

  emit(name: string) {
    this.dispatchEvent(new Event(name))
  }
}

const sounds = new Set<LocalLiveAudio>()

beforeEach(() => {
  vi.useFakeTimers()
  SyntheticContext.instances = []
  vi.stubGlobal("AudioContext", SyntheticContext)
})

afterEach(() => {
  for (const sound of sounds) sound.close()
  sounds.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function chunk(
  sequence: number,
  startSeconds: number,
  codec: "alaw" | "ulaw" = "alaw"
): AudioChunk {
  return {
    sequence,
    startSeconds,
    codec,
    sampleRate: 8000,
    channels: 1,
    data: Buffer.alloc(4000, sequence + 16).toString("base64"),
  }
}

function result(chunks: AudioChunk[], offset = 100): AudioResult {
  return { status: "available", videoStartSeconds: offset, chunks }
}

function setup(
  video: SyntheticVideo,
  load: AudioLoader,
  offset: () => number | undefined = () => 100,
  playback = false
) {
  const onError = vi.fn()
  const sound = new LocalLiveAudio(
    video as unknown as HTMLVideoElement,
    load,
    offset,
    onError,
    playback
  )
  sounds.add(sound)
  return {
    sound,
    onError,
    context: SyntheticContext.instances.at(-1)!,
  }
}

async function start(sound: LocalLiveAudio) {
  await sound.start()
  await vi.advanceTimersByTimeAsync(0)
}

describe("local G.711 scheduling with synthetic Web Audio and media clocks", () => {
  it.each(["alaw", "ulaw"] as const)(
    "starts %s at a nonzero live-edge position without playing expired packets",
    async (codec) => {
      const video = new SyntheticVideo()
      video.currentTime = 12.25
      const load = vi
        .fn<AudioLoader>()
        .mockResolvedValue(
          result([
            chunk(0, 110, codec),
            chunk(1, 112, codec),
            chunk(2, 112.5, codec),
            chunk(3, 113.1, codec),
          ])
        )
      const { sound, context, onError } = setup(video, load)
      await start(sound)

      expect(load).toHaveBeenCalledWith({
        after: -1,
        at: undefined,
        signal: expect.any(AbortSignal),
      })
      expect(context.sources).toHaveLength(2)
      expect(context.sources[0].start).toHaveBeenCalledWith(50.02, 0.25)
      expect(context.sources[1].start).toHaveBeenCalledWith(50.27, 0)
      expect(context.sources[0].buffer?.sampleRate).toBe(8000)
      expect(context.sources[0].buffer?.getChannelData(0)).toHaveLength(4000)
      expect(context.sources[0].buffer?.getChannelData(0)[0]).not.toBe(0)
      expect(onError).not.toHaveBeenCalled()
    }
  )

  it("uses the source's video PTS origin until the player supplies an offset", async () => {
    const video = new SyntheticVideo()
    video.currentTime = 7.2
    const load = vi
      .fn<AudioLoader>()
      .mockResolvedValue(result([chunk(0, 1007)], 1000))
    const { sound, context } = setup(video, load, () => undefined)
    await start(sound)

    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].start.mock.calls[0][0]).toBeCloseTo(50.02)
    expect(context.sources[0].start.mock.calls[0][1]).toBeCloseTo(0.2)
  })

  it("stops live audio immediately on seeking and resumes only the target PTS", async () => {
    const video = new SyntheticVideo()
    video.currentTime = 0.1
    const load = vi
      .fn<AudioLoader>()
      .mockResolvedValue(
        result([chunk(0, 100), chunk(1, 100.8), chunk(2, 102)])
      )
    const { sound, context, onError } = setup(video, load)
    await start(sound)
    const old = context.sources[0]
    expect(context.sources).toHaveLength(1)

    video.seeking = true
    video.currentTime = 2.1
    video.emit("seeking")
    expect(old.stop).toHaveBeenCalledOnce()
    expect(old.disconnect).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(300)
    expect(context.sources).toHaveLength(1)

    video.seeking = false
    video.emit("seeked")
    await vi.advanceTimersByTimeAsync(100)
    expect(context.sources).toHaveLength(2)
    const current = context.sources[1]
    expect(current.buffer?.getChannelData(0)[0]).not.toBe(
      old.buffer?.getChannelData(0)[0]
    )
    expect(current.start.mock.calls[0][0]).toBeCloseTo(50.02)
    expect(current.start.mock.calls[0][1]).toBeCloseTo(0.1)
    expect(onError).not.toHaveBeenCalled()
  })

  it.each(["waiting", "pause", "ended"])(
    "does not schedule while %s and follows the current time after playing",
    async (event) => {
      const video = new SyntheticVideo()
      const load = vi
        .fn<AudioLoader>()
        .mockResolvedValue(result([chunk(0, 100)]))
      const { sound, context, onError } = setup(video, load)
      await start(sound)
      const old = context.sources[0]

      if (event === "waiting") video.readyState = 2
      else video.paused = true
      video.emit(event)
      expect(old.stop).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(300)
      expect(context.sources).toHaveLength(1)

      video.currentTime = 0.2
      video.paused = false
      video.readyState = 4
      video.emit("playing")
      await vi.advanceTimersByTimeAsync(100)
      expect(context.sources).toHaveLength(2)
      expect(context.sources[1].start).toHaveBeenCalledWith(50.02, 0.2)
      expect(onError).not.toHaveBeenCalled()
    }
  )

  it("replaces scheduled sources with rate-correct offsets and deadlines", async () => {
    const video = new SyntheticVideo()
    video.currentTime = 1.1
    const load = vi
      .fn<AudioLoader>()
      .mockResolvedValue(result([chunk(0, 101), chunk(1, 101.4)]))
    const { sound, context, onError } = setup(video, load)
    await start(sound)
    const old = [...context.sources]
    expect(old).toHaveLength(2)

    video.currentTime = 1.2
    video.playbackRate = 2
    video.emit("ratechange")
    for (const source of old) {
      expect(source.stop).toHaveBeenCalledOnce()
      expect(source.disconnect).toHaveBeenCalledOnce()
    }
    expect(context.sources).toHaveLength(4)
    const [current, next] = context.sources.slice(2)
    expect(current.playbackRate.value).toBe(2)
    expect(next.playbackRate.value).toBe(2)
    expect(current.start.mock.calls[0][0]).toBeCloseTo(50.02)
    expect(current.start.mock.calls[0][1]).toBeCloseTo(0.2)
    expect(next.start.mock.calls[0][0]).toBeCloseTo(50.12)
    expect(next.start.mock.calls[0][1]).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(context.sources).toHaveLength(4)
    expect(onError).not.toHaveBeenCalled()
  })

  it("drops a pending pre-seek playback response and resets its time and cursor", async () => {
    const video = new SyntheticVideo()
    let resolveOld!: (value: AudioResult) => void
    const load = vi
      .fn<AudioLoader>()
      .mockResolvedValueOnce(result([chunk(0, 100)]))
      .mockImplementationOnce(
        () => new Promise<AudioResult>((resolve) => (resolveOld = resolve))
      )
      .mockResolvedValue(result([chunk(9, 110)]))
    const { sound, context, onError } = setup(video, load, () => 100, true)
    await start(sound)
    await vi.advanceTimersByTimeAsync(500)
    expect(load).toHaveBeenCalledTimes(2)

    video.currentTime = 10.1
    video.seeking = true
    video.emit("seeking")
    resolveOld(result([chunk(1, 100.5)]))
    await vi.advanceTimersByTimeAsync(0)
    expect(context.sources).toHaveLength(1)
    video.seeking = false
    video.emit("seeked")
    await vi.advanceTimersByTimeAsync(500)

    expect(load).toHaveBeenLastCalledWith({
      after: -1,
      at: 10.1,
      signal: expect.any(AbortSignal),
    })
    expect(context.sources).toHaveLength(2)
    expect(context.sources[1].start.mock.calls[0][1]).toBeCloseTo(0.1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("closes pending requests, timers and every video listener without an error callback", async () => {
    const video = new SyntheticVideo()
    const added = vi.spyOn(video, "addEventListener")
    const removed = vi.spyOn(video, "removeEventListener")
    const load = vi.fn<AudioLoader>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Synthetic abort", "AbortError")),
            { once: true }
          )
        })
    )
    const { sound, context, onError } = setup(video, load)
    await start(sound)
    const signal = load.mock.calls[0][0].signal

    sound.close()
    sound.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(signal.aborted).toBe(true)
    expect(context.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(added).toHaveBeenCalledTimes(7)
    expect(removed).toHaveBeenCalledTimes(7)
    for (const [name, listener] of added.mock.calls)
      expect(removed).toHaveBeenCalledWith(name, listener)
    for (const [name] of added.mock.calls) video.emit(name)
    expect(load).toHaveBeenCalledOnce()
    expect(context.sources).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
  })

  it("stops all queued audio when switched off and starts with a fresh request when switched on", async () => {
    const video = new SyntheticVideo()
    const load = vi.fn<AudioLoader>().mockResolvedValue(result([chunk(0, 100)]))
    const first = setup(video, load)
    await start(first.sound)
    const old = first.context.sources[0]
    first.sound.close()
    expect(old.stop).toHaveBeenCalledOnce()
    expect(old.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    const second = setup(video, load)
    await start(second.sound)
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls[0][0].signal.aborted).toBe(true)
    expect(load.mock.calls[1][0].signal.aborted).toBe(false)
    expect(load.mock.calls[1][0].after).toBe(-1)
    expect(second.context.sources).toHaveLength(1)
    expect(first.context.sources).toHaveLength(1)
    second.sound.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(vi.getTimerCount()).toBe(0)
    expect(first.onError).not.toHaveBeenCalled()
    expect(second.onError).not.toHaveBeenCalled()
  })
})
