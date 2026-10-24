import { describe, expect, it, vi } from "vitest"
import { readNvrConfig } from "../server/config"
import {
  compareFileDuration,
  middleTimeWindow,
  queryTimeWindow,
  summarizeTimeWindow,
} from "../server/time-diagnostics"
import { dayRange } from "../server/time"
import type { RawSegment } from "../server/xml"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "synthetic-user",
  NVR_PASSWORD: "synthetic-secret",
})
const range = dayRange("2026-10-17", "Asia/Shanghai")
const segment = (
  startAt = "2026-10-16T16:00:00Z",
  endAt = "2026-10-16T18:00:00Z",
  file = "synthetic-file"
): RawSegment => ({
  trackId: "101",
  startAt,
  endAt,
  playbackURI: `rtsp://nvr.test/Streaming/tracks/101/?name=${file}&size=123`,
})
const xml = (segments: RawSegment[], more = false) =>
  `<CMSearchResult><responseStatus>true</responseStatus><responseStatusStrg>${more ? "MORE" : "OK"}</responseStatusStrg><numOfMatches>${segments.length}</numOfMatches><matchList>${segments.map((item) => `<searchMatchItem><trackID>${item.trackId}</trackID><timeSpan><startTime>${item.startAt}</startTime><endTime>${item.endAt}</endTime></timeSpan><mediaSegmentDescriptor><playbackURI>${item.playbackURI.replaceAll("&", "&amp;")}</playbackURI></mediaSegmentDescriptor></searchMatchItem>`).join("")}</matchList></CMSearchResult>`

describe("read-only device time evidence", () => {
  it("keeps out-of-window results visible and uses the vendor pagination spelling", async () => {
    const outside = segment("2026-10-17T18:00:00Z", "2026-10-17T19:00:00Z")
    const request = vi.fn().mockResolvedValue(xml([outside]))
    const result = await queryTimeWindow({ request }, config, "101", range)
    expect(result).toHaveLength(1)
    expect(request.mock.calls[0][1]).toContain(
      "<endTime>2026-10-17T15:59:59Z</endTime>"
    )
    expect(request.mock.calls[0][1]).toContain(
      "<searchResultPostion>0</searchResultPostion>"
    )
    expect(
      summarizeTimeWindow(result, range, config).outsideRequestedWindow
    ).toBe(1)
  })

  it("deduplicates page boundaries and rejects repeated pages", async () => {
    const first = segment()
    const second = segment(
      "2026-10-16T18:00:00Z",
      "2026-10-16T20:00:00Z",
      "second"
    )
    const request = vi
      .fn()
      .mockResolvedValueOnce(xml([first], true))
      .mockResolvedValueOnce(xml([first, second]))
    expect(
      await queryTimeWindow({ request }, config, "101", range)
    ).toHaveLength(2)
    expect(request.mock.calls[1][1]).toContain(
      "<searchResultPostion>1</searchResultPostion>"
    )
    const stalled = vi.fn().mockResolvedValue(xml([first], true))
    await expect(
      queryTimeWindow({ request: stalled }, config, "101", range)
    ).rejects.toMatchObject({ code: "NVR_PAGINATION_STALLED" })
    expect(stalled).toHaveBeenCalledTimes(2)
  })

  it("rejects foreign tracks, untrusted media addresses and total deadline expiry", async () => {
    for (const item of [
      { ...segment(), trackId: "201" },
      { ...segment(), playbackURI: "rtsp://foreign.test/secret" },
    ]) {
      await expect(
        queryTimeWindow(
          { request: vi.fn().mockResolvedValue(xml([item])) },
          config,
          "101",
          range
        )
      ).rejects.toMatchObject({
        code:
          item.trackId === "201" ? "NVR_TRACK_MISMATCH" : "NVR_UNTRUSTED_URI",
      })
    }
    const request = vi.fn()
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(30_000)
    await expect(
      queryTimeWindow({ request }, config, "101", range, now)
    ).rejects.toMatchObject({ code: "NVR_TIMEOUT" })
    expect(request).not.toHaveBeenCalled()
  })

  it("compares shared files without exposing any file identifiers, host or credentials", () => {
    const reference = segment()
    const narrow = segment("2026-10-16T17:00:00Z", "2026-10-16T17:00:30Z")
    const result = summarizeTimeWindow([narrow], range, config, [reference])
    expect(result.matchingReferenceFiles).toBe(1)
    expect(result.metadataDurationSeconds).toEqual({
      min: 30,
      max: 30,
      total: 30,
    })
    expect(result.matchingFilesWithChangedMetadataSpan).toBe(1)
    expect(
      summarizeTimeWindow([reference, narrow], range, config)
        .duplicateFileReferences
    ).toBe(1)
    expect(JSON.stringify(result)).not.toMatch(
      /nvr\.test|synthetic-file|synthetic-user|synthetic-secret|playbackURI/
    )
    expect(
      summarizeTimeWindow(
        [{ ...narrow, playbackURI: "rtsp://nvr.test/Streaming/tracks/101/" }],
        range,
        config,
        [reference]
      ).matchingReferenceFiles
    ).toBe(0)
  })

  it("reports an eight-hour candidate as evidence only without mutating source times", () => {
    const item = segment("2026-10-18T12:00:00Z", "2026-10-18T13:00:00Z")
    const snapshot = structuredClone(item)
    const summary = summarizeTimeWindow(
      [item],
      range,
      config,
      [],
      Date.parse("2026-10-18T05:00:00Z")
    )
    expect(summary.latestEndLeadSeconds).toBe(8 * 3600)
    expect(summary.wallClockCandidateLeadSeconds).toBe(0)
    expect(item).toEqual(snapshot)
  })

  it("does not invent a candidate instant across ambiguous DST wall time or for empty data", () => {
    const ny = { ...config, NVR_TIME_ZONE: "America/New_York" }
    expect(
      summarizeTimeWindow(
        [segment("2026-11-01T01:00:00Z", "2026-11-01T01:30:00Z")],
        range,
        ny
      ).wallClockCandidateLeadSeconds
    ).toBeNull()
    const empty = summarizeTimeWindow([], range, config)
    expect(empty.metadataDurationSeconds).toBeNull()
    expect(empty.latestEndLeadSeconds).toBeNull()
    expect(empty.wallClockCandidateLeadSeconds).toBeNull()
  })

  it("generates a bounded inner query and distinguishes metadata duration from media mapping", () => {
    const item = segment()
    const narrow = middleTimeWindow(item)!
    expect(Date.parse(narrow.startAt)).toBeGreaterThan(Date.parse(item.startAt))
    expect(Date.parse(narrow.endAt)).toBeLessThan(Date.parse(item.endAt))
    expect(Date.parse(narrow.endAt) - Date.parse(narrow.startAt)).toBe(30_000)
    expect(
      middleTimeWindow(segment("2026-10-16T16:00:00Z", "2026-10-16T16:00:02Z"))
    ).toBeUndefined()
    expect(compareFileDuration(item, 7224.04)).toEqual({
      metadataDurationSeconds: 7200,
      suppliedMediaDurationSeconds: 7224.04,
      differenceSeconds: 24.04,
      mediaAnchorVerified: false,
    })
  })
})
