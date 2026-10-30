import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { attachNativeLiveSync } from "../lib/native-live-sync"

function ranges(...intervals: [number, number][]): TimeRanges {
  return {
    length: intervals.length,
    start: (index) => intervals[index][0],
    end: (index) => intervals[index][1],
  }
}

class FakeVideo extends EventTarget {
  paused = false
  ended = false
  readyState = 2
  seeking = false
  seekable: TimeRanges | undefined = ranges([0, 30])
  playbackRate = 1
  position = 0
  seeks: number[] = []
  failSeek = false
  onSeek?: () => void
  play = vi.fn()
  get currentTime() {
    return this.position
  }
  set currentTime(value: number) {
    this.seeks.push(value)
    this.onSeek?.()
    if (this.failSeek) throw new DOMException("Not ready", "InvalidStateError")
    this.position = value
  }
  get buffered() {
    throw new Error("Buffered data must not define the live edge")
  }
}

describe("native live edge recovery", () => {
  let video: FakeVideo
  let doc: EventTarget & { visibilityState: string }
  let win: EventTarget
  let cleanup: (() => void) | undefined
  function attach(duration = 2) {
    cleanup = attachNativeLiveSync(
      video as unknown as HTMLVideoElement,
      duration
    )
  }
  function dispatch(type = "timeupdate") {
    video.dispatchEvent(new Event(type))
  }
  beforeEach(() => {
    video = new FakeVideo()
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" })
    win = new EventTarget()
    vi.stubGlobal("document", doc)
    vi.stubGlobal("window", win)
  })
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    vi.unstubAllGlobals()
  })

  it("keeps latency at or below the maximum, then seeks to the safe live target", () => {
    attach()
    video.position = 18
    dispatch()
    expect(video.seeks).toEqual([])
    video.position = 17.99
    dispatch()
    expect(video.seeks).toEqual([24])
    dispatch()
    expect(video.seeks).toEqual([24])
    expect(video.play).not.toHaveBeenCalled()
    expect(video.playbackRate).toBe(1)
  })

  it.each(["loadedmetadata", "progress", "timeupdate", "playing"])(
    "recovers on %s only when playback is eligible",
    (event) => {
      attach()
      dispatch(event)
      expect(video.seeks).toEqual([24])
    }
  )

  it("waits in the background, then recovers when visible or restored", () => {
    attach()
    doc.visibilityState = "hidden"
    dispatch("progress")
    win.dispatchEvent(new Event("pageshow"))
    expect(video.seeks).toEqual([])
    doc.visibilityState = "visible"
    doc.dispatchEvent(new Event("visibilitychange"))
    expect(video.seeks).toEqual([24])
    video.seekable = ranges([20, 60])
    win.dispatchEvent(new Event("pageshow"))
    expect(video.seeks).toEqual([24, 54])
  })

  it.each([
    { paused: true },
    { ended: true },
    { readyState: 1 },
    { seeking: true },
  ])("does not override ineligible playback state %j", (state) => {
    Object.assign(video, state)
    attach()
    dispatch("playing")
    doc.dispatchEvent(new Event("visibilitychange"))
    win.dispatchEvent(new Event("pageshow"))
    expect(video.seeks).toEqual([])
    expect(video.play).not.toHaveBeenCalled()
  })

  it("uses the last seekable range and clamps the target to that range", () => {
    video.seekable = ranges([0, 10], [28, 30])
    attach()
    dispatch()
    expect(video.seeks).toEqual([28])
  })

  it.each([
    undefined,
    ranges(),
    ranges([0, NaN]),
    ranges([NaN, 30]),
    ranges([0, Infinity]),
    ranges([30, 30]),
    ranges([31, 30]),
    { length: -1, start: () => 0, end: () => 30 },
    { length: NaN, start: () => 0, end: () => 30 },
    { length: 0.5, start: () => 0, end: () => 30 },
  ])("ignores missing or invalid seekable ranges %j", (seekable) => {
    video.seekable = seekable
    attach()
    dispatch()
    expect(video.seeks).toEqual([])
  })

  it.each([NaN, Infinity])("ignores invalid current time %s", (position) => {
    video.position = position
    attach()
    dispatch()
    expect(video.seeks).toEqual([])
  })

  it.each([0, -1, NaN, Infinity])(
    "does not attach recovery for invalid target duration %s",
    (duration) => {
      attach(duration)
      dispatch()
      expect(video.seeks).toEqual([])
    }
  )

  it("retries after temporary seekable read failures", () => {
    const getRanges = vi.fn(() => {
      throw new DOMException("No ranges", "InvalidStateError")
    })
    Object.defineProperty(video, "seekable", {
      configurable: true,
      get: getRanges,
    })
    attach()
    expect(() => dispatch()).not.toThrow()
    Object.defineProperty(video, "seekable", {
      configurable: true,
      value: {
        length: 1,
        start: () => {
          throw new DOMException("Stale range", "IndexSizeError")
        },
        end: () => 30,
      },
    })
    expect(() => dispatch()).not.toThrow()
    Object.defineProperty(video, "seekable", { value: ranges([0, 30]) })
    dispatch()
    expect(video.seeks).toEqual([24])
  })

  it("contains seek assignment errors and synchronous recursive events", () => {
    video.failSeek = true
    video.onSeek = () => dispatch()
    attach()
    expect(() => dispatch()).not.toThrow()
    expect(video.seeks).toEqual([24])
    video.failSeek = false
    dispatch()
    expect(video.seeks).toEqual([24, 24])
    expect(video.position).toBe(24)
  })

  it("removes every listener and never adjusts the old session after cleanup", () => {
    const removedVideo = vi.spyOn(video, "removeEventListener")
    const removedDocument = vi.spyOn(doc, "removeEventListener")
    const removedWindow = vi.spyOn(win, "removeEventListener")
    attach()
    cleanup?.()
    cleanup?.()
    expect(removedVideo).toHaveBeenCalledTimes(4)
    expect(removedDocument).toHaveBeenCalledExactlyOnceWith(
      "visibilitychange",
      expect.any(Function)
    )
    expect(removedWindow).toHaveBeenCalledExactlyOnceWith(
      "pageshow",
      expect.any(Function)
    )
    for (const event of ["loadedmetadata", "progress", "timeupdate", "playing"])
      dispatch(event)
    doc.dispatchEvent(new Event("visibilitychange"))
    win.dispatchEvent(new Event("pageshow"))
    expect(video.seeks).toEqual([])
  })
})
