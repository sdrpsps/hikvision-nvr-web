import { describe, expect, it } from "vitest"
import {
  liveUrlParsers,
  playbackUrlParsers,
  parseAsSlots,
  parseAsRecordingDate,
  parseAsTrack,
} from "../lib/url-state"

describe("URL state parsers", () => {
  it("keeps valid date-only strings independent of system timezone", () => {
    expect(parseAsRecordingDate.parse("2026-10-25")).toBe("2026-10-25")
    for (const value of [
      "2026-02-30",
      "2026-1-2",
      "2026-10-25T00:00:00Z",
      "tomorrow",
    ])
      expect(parseAsRecordingDate.parse(value)).toBeNull()
  })
  it("restricts tracks, layouts, selected windows and zoom", () => {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "https://nvr.test",
      "101/../../",
      "1234567890",
    ])
      expect(parseAsTrack.parse(value)).toBeNull()
    expect(playbackUrlParsers.zoom.parse("3")).toBeNull()
    expect(playbackUrlParsers.zoom.parse("4")).toBe("4")
    expect(liveUrlParsers.layout.parse("64")).toBeNull()
    for (const value of ["0", "17", "2abc", "2.5", "01"])
      expect(liveUrlParsers.window.parse(value)).toBeNull()
  })
  it("restores shared sidebar state with an expanded default", () => {
    for (const sidebar of [
      playbackUrlParsers.sidebar,
      liveUrlParsers.sidebar,
    ]) {
      expect(sidebar.parse("false")).toBe(false)
      expect(sidebar.serialize(false)).toBe("false")
      expect(sidebar.parse(sidebar.serialize(true))).toBe(true)
      expect(sidebar.parseServerSide("false")).toBe(false)
      expect(sidebar.parseServerSide(undefined)).toBe(true)
      for (const value of ["invalid", "False", "0", ""]) {
        expect(sidebar.parse(value)).toBeNull()
        expect(sidebar.parseServerSide(value)).toBe(true)
      }
    }
  })
  it("round trips bounded slot assignments, including an explicitly empty window", () => {
    const state = { 0: "201", 2: "", 15: "1601" }
    expect(parseAsSlots.serialize(state)).toBe("1:201,3:0,16:1601")
    expect(parseAsSlots.parse(parseAsSlots.serialize(state))).toEqual(state)
    expect(parseAsSlots.eq?.({}, {})).toBe(true)
    for (const value of [
      "1:101,1:201",
      "0:101",
      "17:101",
      "1:https://nvr.test",
      "1:101:x",
      "1:",
      "x".repeat(241),
    ])
      expect(parseAsSlots.parse(value)).toBeNull()
  })
})
