import { afterEach, describe, expect, it, vi } from "vitest"
import { observeLiveStartup, recordLiveRequest } from "../lib/live-metrics"
import type { LiveStream } from "../shared/contracts"

function setup(frameCallbacks = true) {
  const callbacks = new Map<number, VideoFrameRequestCallback>()
  let next = 0
  const video = Object.assign(new EventTarget(), {
    dataset: {} as DOMStringMap,
    paused: true,
    readyState: 2,
    requestVideoFrameCallback: frameCallbacks
      ? vi.fn((callback: VideoFrameRequestCallback) => {
          callbacks.set(++next, callback)
          return next
        })
      : undefined,
    cancelVideoFrameCallback: vi.fn((id: number) => callbacks.delete(id)),
  })
  const session: LiveStream = {
    id: "11111111-1111-4111-8111-111111111111",
    playlistUrl: "/api/streams/11111111-1111-4111-8111-111111111111/index.m3u8",
    expiresAt: "2026-10-30T00:10:00Z",
    mode: "stream-copy",
    codec: "h264",
    startup: {
      firstByteMs: 5,
      firstFragmentMs: 10,
      firstIndependentFragmentMs: 15,
      readyMs: 25,
    },
  }
  const frame = (time = 2) => {
    const [id, callback] = callbacks.entries().next().value!
    callbacks.delete(id)
    callback(performance.now(), {
      mediaTime: time,
    } as VideoFrameCallbackMetadata)
  }
  return {
    video,
    element: video as unknown as HTMLVideoElement,
    session,
    callbacks,
    frame,
    sample: () => JSON.parse(video.dataset.liveStartup!),
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function visibility(initial = "visible") {
  const document = Object.assign(new EventTarget(), {
    visibilityState: initial,
  })
  const removed = vi.spyOn(document, "removeEventListener")
  vi.stubGlobal("document", document)
  return {
    removed,
    set(state: string) {
      document.visibilityState = state
      document.dispatchEvent(new Event("visibilitychange"))
    },
  }
}

describe("live startup observations", () => {
  it("separates API, mount, playing and the first submitted frame without pixels", () => {
    vi.useFakeTimers()
    const { element, video, session, sample, frame, callbacks } = setup()
    const started = vi.fn()
    const at = performance.now()
    vi.advanceTimersByTime(30)
    recordLiveRequest(session, at)
    vi.advanceTimersByTime(10)
    const stop = observeLiveStartup(element, session, started)
    expect(sample()).toMatchObject({
      server: session.startup,
      apiMs: 30,
      mountedMs: 40,
      playingMs: null,
      firstFrameMs: null,
      frameCallbackSupported: true,
    })
    // A decoded frame while paused is not evidence of active playback.
    frame()
    expect(started).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10)
    video.paused = false
    video.dispatchEvent(new Event("playing"))
    expect(sample().playingMs).toBe(50)
    expect(sample().firstFrameMs).toBeNull()
    expect(started).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    frame(5.25)
    expect(sample()).toMatchObject({
      firstFrameMs: 66,
      firstFrameMediaSeconds: 5.25,
    })
    expect(started).toHaveBeenCalledTimes(1)
    expect(callbacks.size).toBe(0)
    video.dispatchEvent(new Event("playing"))
    expect(sample().playingMs).toBe(50)
    stop()
    expect(video.dataset.liveStartup).toBeUndefined()
  })

  it("does not label playing as a displayed frame when frame callbacks are unavailable", () => {
    const { element, video, session, sample } = setup(false)
    const started = vi.fn()
    delete session.startup
    const stop = observeLiveStartup(element, session, started)
    video.paused = false
    video.dispatchEvent(new Event("playing"))
    expect(started).toHaveBeenCalledOnce()
    expect(sample()).toMatchObject({
      server: null,
      apiMs: null,
      mountedMs: 0,
      firstFrameMs: null,
      frameCallbackSupported: false,
    })
    stop()
  })

  it("ignores a frame before playing or before media data is ready", () => {
    const { element, video, session, frame, sample } = setup()
    const started = vi.fn()
    const stop = observeLiveStartup(element, session, started)
    video.paused = false
    frame()
    video.readyState = 1
    video.dispatchEvent(new Event("playing"))
    frame()
    expect(started).not.toHaveBeenCalled()
    expect(sample().firstFrameMs).toBeNull()
    video.readyState = 2
    frame()
    expect(started).toHaveBeenCalledOnce()
    stop()
  })

  it("cancels pending callbacks and late events cannot resurrect a stopped observation", () => {
    const { element, video, session, callbacks } = setup()
    const started = vi.fn()
    const stop = observeLiveStartup(element, session, started)
    const late = callbacks.values().next().value!
    stop()
    video.paused = false
    video.dispatchEvent(new Event("playing"))
    late(performance.now(), { mediaTime: 3 } as VideoFrameCallbackMetadata)
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1)
    expect(callbacks.size).toBe(0)
    expect(started).not.toHaveBeenCalled()
    expect(video.dataset.liveStartup).toBeUndefined()
  })

  it("keeps concurrent sessions and their request clocks separate", () => {
    vi.useFakeTimers()
    const first = setup()
    const second = setup()
    const at = performance.now()
    vi.advanceTimersByTime(10)
    recordLiveRequest(first.session, at)
    vi.advanceTimersByTime(30)
    recordLiveRequest(second.session, performance.now())
    const stopFirst = observeLiveStartup(first.element, first.session, vi.fn())
    const stopSecond = observeLiveStartup(
      second.element,
      second.session,
      vi.fn()
    )
    expect(first.sample().apiMs).toBe(10)
    expect(first.sample().mountedMs).toBe(40)
    expect(second.sample().apiMs).toBe(0)
    stopFirst()
    expect(second.sample().frameCallbackSupported).toBe(true)
    stopSecond()
  })

  it("does not spend the visible deadline while starting in a hidden tab", () => {
    vi.useFakeTimers()
    const visible = visibility("hidden")
    const { element, video, session, callbacks } = setup()
    const started = vi.fn()
    const timedOut = vi.fn()
    const stop = observeLiveStartup(element, session, started, timedOut)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(90_000)
    expect(timedOut).not.toHaveBeenCalled()
    visible.set("visible")
    vi.advanceTimersByTime(29_999)
    expect(timedOut).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(timedOut).toHaveBeenCalledOnce()
    expect(started).not.toHaveBeenCalled()
    expect(callbacks.size).toBe(0)
    expect(video.dataset.liveStartup).toBeUndefined()
    expect(visible.removed).toHaveBeenCalledExactlyOnceWith(
      "visibilitychange",
      expect.any(Function)
    )
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it("pauses the remaining budget in hidden tabs and resumes it without resetting", () => {
    vi.useFakeTimers()
    const visible = visibility()
    const { element, video, session, sample } = setup()
    const started = vi.fn()
    const timedOut = vi.fn()
    const stop = observeLiveStartup(element, session, started, timedOut)
    video.paused = false
    video.dispatchEvent(new Event("playing"))
    vi.advanceTimersByTime(10_000)
    visible.set("hidden")
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(sample().firstFrameMs).toBeNull()
    expect(timedOut).not.toHaveBeenCalled()
    visible.set("visible")
    vi.advanceTimersByTime(5000)
    visible.set("visible")
    vi.advanceTimersByTime(14_999)
    expect(timedOut).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(timedOut).toHaveBeenCalledOnce()
    expect(started).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    visible.set("hidden")
    visible.set("visible")
    vi.advanceTimersByTime(30_000)
    expect(timedOut).toHaveBeenCalledOnce()
    stop()
  })

  it("keeps wall-clock first-frame metrics but cancels the visible deadline on success", () => {
    vi.useFakeTimers()
    const visible = visibility()
    const { element, video, session, frame, sample } = setup()
    const started = vi.fn()
    const timedOut = vi.fn()
    const stop = observeLiveStartup(element, session, started, timedOut)
    video.paused = false
    video.dispatchEvent(new Event("playing"))
    vi.advanceTimersByTime(10_000)
    visible.set("hidden")
    vi.advanceTimersByTime(60_000)
    visible.set("visible")
    vi.advanceTimersByTime(10_000)
    frame(12)
    expect(sample()).toMatchObject({
      firstFrameMs: 80_000,
      firstFrameMediaSeconds: 12,
    })
    expect(started).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(visible.removed).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function)
    )
    visible.set("hidden")
    visible.set("visible")
    vi.advanceTimersByTime(60_000)
    expect(timedOut).not.toHaveBeenCalled()
    stop()
  })

  it("cancels the guarded fallback on playing without inventing a displayed frame", () => {
    vi.useFakeTimers()
    const visible = visibility()
    const { element, video, session, sample } = setup(false)
    const started = vi.fn()
    const timedOut = vi.fn()
    const stop = observeLiveStartup(element, session, started, timedOut)
    video.paused = false
    video.dispatchEvent(new Event("playing"))
    video.dispatchEvent(new Event("playing"))
    expect(started).toHaveBeenCalledOnce()
    expect(sample().firstFrameMs).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    visible.set("hidden")
    visible.set("visible")
    vi.advanceTimersByTime(60_000)
    expect(timedOut).not.toHaveBeenCalled()
    stop()
  })

  it.each(["visible", "hidden"])(
    "releases the guarded %s observation and ignores every late event",
    (state) => {
      vi.useFakeTimers()
      const visible = visibility(state)
      const { element, video, session, callbacks } = setup()
      const removed = vi.spyOn(video, "removeEventListener")
      const started = vi.fn()
      const timedOut = vi.fn()
      const stop = observeLiveStartup(element, session, started, timedOut)
      const late = callbacks.values().next().value!
      stop()
      stop()
      expect(callbacks.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(visible.removed).toHaveBeenCalledExactlyOnceWith(
        "visibilitychange",
        expect.any(Function)
      )
      expect(removed).toHaveBeenCalledExactlyOnceWith(
        "playing",
        expect.any(Function)
      )
      video.paused = false
      video.dispatchEvent(new Event("playing"))
      late(performance.now(), { mediaTime: 4 } as VideoFrameCallbackMetadata)
      visible.set("hidden")
      visible.set("visible")
      vi.advanceTimersByTime(60_000)
      expect(started).not.toHaveBeenCalled()
      expect(timedOut).not.toHaveBeenCalled()
      expect(video.dataset.liveStartup).toBeUndefined()
    }
  )
})
