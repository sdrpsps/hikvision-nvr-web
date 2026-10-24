import { describe, expect, it, vi } from "vitest"
import { readNvrConfig } from "../server/config"
import { NvrService } from "../server/recordings"
import type { IsapiClient } from "../server/isapi"
import { dayRange, recordingInstant, recordingSearchTime } from "../server/time"
import { parseSearch } from "../server/xml"
import { createApp } from "../server/app"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "synthetic-user",
  NVR_PASSWORD: "synthetic-secret",
})
const local = { timeZone: "Asia/Shanghai", mode: "device-local" } as const
const xml = (start = "2026-10-17T00:00:00Z", end = "2026-10-17T23:59:59Z") =>
  `<CMSearchResult><responseStatus>true</responseStatus><responseStatusStrg>OK</responseStatusStrg><numOfMatches>1</numOfMatches><matchList><searchMatchItem><trackID>101</trackID><timeSpan><startTime>${start}</startTime><endTime>${end}</endTime></timeSpan><mediaSegmentDescriptor><playbackURI>rtsp://nvr.test/Streaming/tracks/101/?name=synthetic-only&amp;size=123</playbackURI></mediaSegmentDescriptor></searchMatchItem></matchList></CMSearchResult>`

function serviceWith(response: string, mode = config.NVR_RECORDING_TIME_MODE) {
  const request = vi.fn<IsapiClient["request"]>(async (path: string) =>
    path.endsWith("tracks")
      ? "<TrackList><Track><id>101</id><Enable>false</Enable></Track></TrackList>"
      : response
  )
  return {
    request,
    service: new NvrService({ ...config, NVR_RECORDING_TIME_MODE: mode }, {
      request,
    } as unknown as IsapiClient),
  }
}

describe("recording time at the device boundary", () => {
  it("defaults to Beijing and the observed device-local wire convention", () => {
    expect(config.NVR_TIME_ZONE).toBe("Asia/Shanghai")
    expect(config.NVR_RECORDING_TIME_MODE).toBe("device-local")
    expect(() =>
      readNvrConfig({
        NVR_HOST: "nvr.test",
        NVR_USERNAME: "synthetic-user",
        NVR_PASSWORD: "synthetic-secret",
        NVR_RECORDING_TIME_MODE: "guess",
      })
    ).toThrow()
  })

  it("round-trips Beijing midnight without an additional eight-hour offset", () => {
    const range = dayRange("2026-10-17", local.timeZone)
    expect(recordingSearchTime(range.startAt, local)).toBe(
      "2026-10-17T00:00:00Z"
    )
    expect(recordingSearchTime("2026-10-17T15:59:59Z", local)).toBe(
      "2026-10-17T23:59:59Z"
    )
    expect(recordingInstant("2026-10-17T00:00:00Z", local)).toBe(
      "2026-10-16T16:00:00.000Z"
    )
    const display = new Intl.DateTimeFormat("en-GB", {
      timeZone: local.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
    expect(
      display.format(new Date(recordingInstant("2026-10-17T00:00:00Z", local)))
    ).toBe("00:00")
  })

  it("honors explicit offsets and supports standard UTC firmware", () => {
    expect(recordingInstant("2026-10-17T00:00:00+08:00", local)).toBe(
      "2026-10-16T16:00:00.000Z"
    )
    const utc = { ...local, mode: "utc" } as const
    expect(recordingSearchTime("2026-10-16T16:00:00Z", utc)).toBe(
      "2026-10-16T16:00:00Z"
    )
    expect(recordingInstant("2026-10-17T00:00:00Z", utc)).toBe(
      "2026-10-17T00:00:00.000Z"
    )
    expect(parseSearch(xml()).segments[0].startAt).toBe(
      "2026-10-17T00:00:00.000Z"
    )
  })

  it("uses the configured zone for dates across month/year boundaries", () => {
    expect(recordingSearchTime("2026-12-31T16:00:00Z", local)).toBe(
      "2027-01-01T00:00:00Z"
    )
    expect(recordingInstant("2027-01-01T00:00:00Z", local)).toBe(
      "2026-12-31T16:00:00.000Z"
    )
    const tokyo = { ...local, timeZone: "Asia/Tokyo" }
    expect(recordingSearchTime("2026-10-16T15:00:00Z", tokyo)).toBe(
      "2026-10-17T00:00:00Z"
    )
    expect(recordingInstant("2026-10-17T00:00:00Z", tokyo)).toBe(
      "2026-10-16T15:00:00.000Z"
    )
  })

  it("rejects invalid, nonexistent and ambiguous local timestamps", () => {
    const ny = { ...local, timeZone: "America/New_York" }
    for (const value of ["2026-03-08T02:30:00Z", "2026-11-01T01:30:00Z"])
      expect(() =>
        parseSearch(xml(value, "2026-11-02T00:00:00Z"), ny)
      ).toThrow()
    expect(() => parseSearch(xml("2026-02-30T00:00:00Z"), local)).toThrow()
    expect(() => parseSearch(xml("2026-10-18T00:00:00Z"), local)).toThrow()
  })

  it("queries the selected local day, exposes UTC and removes the false last-second gap", async () => {
    const { service, request } = serviceWith(xml())
    const app = createApp(() => service)
    const response = await app.request(
      "/api/recordings?track=101&date=2026-10-17"
    )
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(request.mock.calls[1][1]).toContain(
      "<startTime>2026-10-17T00:00:00Z</startTime>"
    )
    expect(request.mock.calls[1][1]).toContain(
      "<endTime>2026-10-17T23:59:59Z</endTime>"
    )
    expect(result.range).toEqual(dayRange("2026-10-17", "Asia/Shanghai"))
    expect(result.segments[0]).toMatchObject({
      startAt: "2026-10-16T16:00:00.000Z",
      endAt: "2026-10-17T16:00:00.000Z",
    })
    expect(result.gaps).toEqual([])
    expect(result.warnings).toEqual([])
    expect(JSON.stringify(result)).not.toMatch(
      /playbackURI|rtsp:|nvr.test|synthetic/
    )
    const resolved = await service.resolveSegment(
      "101",
      "2026-10-17",
      result.segments[0].id
    )
    expect(resolved.playbackURI).toBe(
      parseSearch(xml()).segments[0].playbackURI
    )
  })

  it("keeps genuine gaps and does not extend a file boundary by one second", async () => {
    const { service } = serviceWith(
      xml("2026-10-17T01:00:00Z", "2026-10-17T02:00:00Z")
    )
    const result = await service.recordings("101", "2026-10-17")
    expect(result.segments[0].endAt).toBe("2026-10-16T18:00:00.000Z")
    expect(result.gaps).toHaveLength(2)
    expect(result.coverage).toEqual([
      {
        startAt: "2026-10-16T17:00:00.000Z",
        endAt: "2026-10-16T18:00:00.000Z",
      },
    ])
  })

  it("does not make current local recordings appear in the future", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-10-24T14:47:00Z"))
    try {
      const { service } = serviceWith(
        xml("2026-10-24T22:00:00Z", "2026-10-24T22:46:56Z")
      )
      const result = await service.recordings("101", "2026-10-24")
      expect(result.segments[0].endAt).toBe("2026-10-24T14:46:56.000Z")
      expect(Date.parse(result.segments[0].endAt)).toBeLessThan(Date.now())
    } finally {
      now.mockRestore()
    }
  })
})
