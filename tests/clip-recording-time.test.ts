import { afterEach, describe, expect, it, vi } from "vitest"
import {
  recordingOffset,
  recordingRange,
  recordingTime,
  recordingDayBounds,
  recordingTimeOfDay,
} from "../lib/browser-save/recording-time"

afterEach(() => vi.unstubAllEnvs())

describe("clip selection by recording time", () => {
  const fileStartAt = "2026-10-24T15:59:00Z"
  it("limits a cross-midnight file to the selected recording day", () => {
    expect(
      recordingDayBounds(fileStartAt, "2026-10-25", "Asia/Shanghai", 3660)
    ).toEqual({ start: 60, end: 3660 })
    expect(
      recordingDayBounds(fileStartAt, "2026-10-25", "Asia/Shanghai", 90000)
    ).toEqual({ start: 60, end: 86460 })
    expect(
      recordingDayBounds(fileStartAt, "2026-10-26", "Asia/Shanghai", 3660)
    ).toBeUndefined()
    expect(recordingTimeOfDay("2026-10-25 13:20:30", "2026-10-25")).toBe(
      "13:20:30"
    )
    expect(recordingTimeOfDay("2026-10-26 00:00:00", "2026-10-25")).toBe(
      "24:00:00"
    )
  })
  it("uses the device's calendar day including DST boundaries", () => {
    expect(
      recordingDayBounds(
        "2026-03-08T05:00:00Z",
        "2026-03-08",
        "America/New_York"
      )
    ).toEqual({ start: 0, end: 23 * 3600 })
  })
  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])(
    "uses the recording zone instead of system zone %s",
    (zone) => {
      vi.stubEnv("TZ", zone)
      expect(recordingTime(fileStartAt, 1260)).toBe("2026-10-25 00:20:00")
      expect(recordingOffset("2026-10-25 00:20:00", fileStartAt)).toBe(1260)
      expect(recordingOffset("2026-10-25T00:20:30", fileStartAt)).toBe(1290)
    }
  )
  it("preserves a full date across midnight and a different device zone", () => {
    expect(recordingRange({ fileStartAt }, 0, 90)).toBe(
      "2026-10-24 23:59:00 — 2026-10-25 00:00:30"
    )
    expect(recordingTime(fileStartAt, 1260, "America/New_York")).toBe(
      "2026-10-24 12:20:00"
    )
    expect(
      recordingOffset("2026-10-24 12:20:00", fileStartAt, "America/New_York")
    ).toBe(1260)
    expect(recordingOffset("2026-10-24 23:58:59", fileStartAt)).toBe(-1)
  })
  it("includes fractional file boundaries in their displayed whole seconds", () => {
    const start = "2026-10-24T15:59:59.500Z"
    expect(recordingTime(start, 0)).toBe("2026-10-24 23:59:59")
    expect(recordingOffset("2026-10-24 23:59:59", start)).toBe(0)
    expect(recordingTime(start, 2.2, undefined, "ceil")).toBe(
      "2026-10-25 00:00:02"
    )
    expect(recordingOffset("2026-10-25 00:00:02", start)).toBe(2.5)
  })
  it.each([
    "",
    "02:00",
    "2026-02-30 12:00:00",
    "2026-10-24 24:00:00",
    "2026-10-24 12:60:00",
    "2026-10-24 12:00:60",
    "2026-10-24 12:00:00Z",
  ])("rejects invalid or incomplete input %s", (value) => {
    expect(recordingOffset(value, fileStartAt)).toBeUndefined()
  })
  it("rejects nonexistent or ambiguous local times rather than silently shifting them", () => {
    expect(
      recordingOffset("2026-03-08 02:30:00", fileStartAt, "America/New_York")
    ).toBeUndefined()
    expect(
      recordingOffset("2026-11-01 01:30:00", fileStartAt, "America/New_York")
    ).toBeUndefined()
  })
})
