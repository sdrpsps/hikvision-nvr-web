import { afterEach, describe, expect, it, vi } from "vitest"
import { playbackInstant, playbackOffset } from "../lib/playback-clock"

afterEach(() => vi.unstubAllEnvs())

describe("wall-clock selection and file-relative media time", () => {
  it("maps Beijing midnight into the prior-day file and returns the same instant", () => {
    const startAt = "2026-10-24T20:49:33+08:00"
    const target = "2026-10-25T00:00:00+08:00"
    expect(playbackOffset(target, startAt)).toBe(11427)
    expect(playbackInstant(startAt, 11427)).toBe("2026-10-24T16:00:00.000Z")
    expect(playbackOffset("2026-10-24T16:00:00Z", startAt)).toBe(11427)
  })

  it("preserves fractional offsets across New Year's midnight", () => {
    const startAt = "2026-12-31T23:59:59.500+08:00"
    const target = "2027-01-01T00:00:00+08:00"
    expect(playbackOffset(target, startAt)).toBe(0.5)
    expect(playbackInstant(startAt, 0.5)).toBe("2026-12-31T16:00:00.000Z")
    expect(playbackInstant(startAt, 0)).toBe("2026-12-31T15:59:59.500Z")
  })

  it("keeps an out-of-file selection negative so callers can reject it", () => {
    const startAt = "2026-10-24T16:00:00Z"
    const beforeFile = "2026-10-24T15:59:59.500Z"
    expect(playbackOffset(beforeFile, startAt)).toBe(-0.5)
    expect(playbackInstant(startAt, -0.5)).toBe(beforeFile)
  })

  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])(
    "keeps the same selected UTC instant when the system TZ is %s",
    (systemZone) => {
      vi.stubEnv("TZ", systemZone)
      const target = "2026-10-25T00:00:00+08:00"
      const startAt = "2026-10-24T12:49:33Z"
      expect(playbackOffset(target, startAt)).toBe(11427)
      expect(playbackInstant(startAt, playbackOffset(target, startAt))).toBe(
        "2026-10-24T16:00:00.000Z"
      )
    }
  )

  it("honors explicit offsets when a wall-clock hour repeats at a DST boundary", () => {
    const startAt = "2026-11-01T01:30:00-04:00"
    const target = "2026-11-01T01:30:00-05:00"
    expect(playbackOffset(target, startAt)).toBe(3600)
    expect(playbackInstant(startAt, 3600)).toBe("2026-11-01T06:30:00.000Z")
  })
})
