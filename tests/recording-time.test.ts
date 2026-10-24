import { describe, expect, it, vi } from "vitest"
import { readNvrConfig } from "../server/config"
import { NvrService } from "../server/recordings"
import { IsapiClient } from "../server/isapi"
import { dayRange, recordingInstant, recordingSearchTime } from "../server/time"
import { parseSearch, type RawSegment } from "../server/xml"
import { createApp } from "../server/app"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "synthetic-user",
  NVR_PASSWORD: "synthetic-secret",
})

describe("full-file duration estimates", () => {
  const date = "2027-01-01"
  const source: RawSegment = {
    trackId: "101",
    startAt: "2026-12-31T16:00:00Z",
    endAt: "2026-12-31T16:05:42Z",
    playbackURI:
      "rtsp://nvr.test/Streaming/tracks/101/?starttime=20270101T000000Z&name=synthetic-file&size=123",
  }
  const previous: RawSegment = {
    ...source,
    startAt: "2026-12-31T14:05:18Z",
    endAt: "2026-12-31T16:00:00Z",
    playbackURI:
      "rtsp://nvr.test/Streaming/tracks/101/?starttime=20261231T220518Z&name=synthetic-file&size=123",
  }
  async function resolveFromDays(
    selected: RawSegment,
    days: Record<string, RawSegment[] | Error>,
    selectedDate = date,
    timeZone = config.NVR_TIME_ZONE
  ) {
    const service = new NvrService({ ...config, NVR_TIME_ZONE: timeZone })
    const query = vi
      .spyOn(service, "queryRaw")
      .mockImplementation(async (_track, date) => {
        const response = days[date]
        if (response instanceof Error) throw response
        return response ?? []
      })
    const result = await service.recordings(selected.trackId, selectedDate)
    query.mockClear()
    const resolved = await service.resolveSegment(
      selected.trackId,
      selectedDate,
      result.segments[0].id
    )
    return { query, resolved, result }
  }

  it("uses an interior file span without additional queries", async () => {
    const interior = { ...source, startAt: "2026-12-31T16:01:00Z" }
    const { query, resolved } = await resolveFromDays(interior, {
      [date]: [interior],
    })
    expect(resolved).toEqual({ ...interior, estimatedDurationSeconds: 282 })
    expect(query.mock.calls.map((call) => call[1])).toEqual([date])
  })

  it("recovers a 7224-second cross-year file from a clipped 342-second day label", async () => {
    const { query, resolved, result } = await resolveFromDays(source, {
      [date]: [source],
      "2026-12-31": [previous],
    })
    expect(resolved).toEqual({ ...source, estimatedDurationSeconds: 7224 })
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      date,
      "2026-12-31",
    ])
    expect(result.segments[0]).not.toHaveProperty("estimatedDurationSeconds")
    expect(JSON.stringify(result)).not.toMatch(
      /playbackURI|synthetic-file|size=123|rtsp:/
    )
  })

  it("queries only the next day for a file clipped at the end of the selected day", async () => {
    const ending: RawSegment = {
      ...source,
      startAt: "2027-01-01T15:55:00Z",
      endAt: "2027-01-01T16:00:00Z",
    }
    const next = {
      ...ending,
      startAt: ending.endAt,
      endAt: "2027-01-01T17:00:00Z",
    }
    const { query, resolved } = await resolveFromDays(ending, {
      [date]: [ending],
      "2027-01-02": [next],
    })
    expect(resolved).toEqual({ ...ending, estimatedDurationSeconds: 3900 })
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      date,
      "2027-01-02",
    ])
  })

  it("bounds searches to two neighboring calendar days across a configured DST transition", async () => {
    const selected: RawSegment = {
      ...source,
      startAt: "2026-03-08T05:00:00Z",
      endAt: "2026-03-09T04:00:00Z",
    }
    const before = {
      ...selected,
      startAt: "2026-03-08T04:00:00Z",
      endAt: selected.startAt,
    }
    const after = {
      ...selected,
      startAt: selected.endAt,
      endAt: "2026-03-09T05:00:00Z",
    }
    const { query, resolved } = await resolveFromDays(
      selected,
      {
        "2026-03-08": [selected],
        "2026-03-07": [before],
        "2026-03-09": [after],
      },
      "2026-03-08",
      "America/New_York"
    )
    expect(resolved).toEqual({ ...selected, estimatedDurationSeconds: 90000 })
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      "2026-03-08",
      "2026-03-07",
      "2026-03-09",
    ])
  })

  it("merges overlapping labels without counting their shared duration twice", async () => {
    const overlapping = { ...previous, endAt: "2026-12-31T16:03:00Z" }
    const { resolved } = await resolveFromDays(source, {
      [date]: [source],
      "2026-12-31": [previous, overlapping],
    })
    expect(resolved).toEqual({ ...source, estimatedDurationSeconds: 7224 })
  })

  it("skips optional searches after the original resolve has already taken five seconds", async () => {
    const service = new NvrService(config)
    const now = vi.spyOn(Date, "now").mockReturnValue(0)
    const query = vi.spyOn(service, "queryRaw").mockResolvedValue([source])
    try {
      const result = await service.recordings(source.trackId, date)
      query.mockClear()
      query.mockImplementation(async () => {
        now.mockReturnValue(5000)
        return [source]
      })
      await expect(
        service.resolveSegment(source.trackId, date, result.segments[0].id)
      ).resolves.toEqual(source)
      expect(query).toHaveBeenCalledExactlyOnceWith(source.trackId, date)
    } finally {
      now.mockRestore()
    }
  })

  it("cancels optional network searches after 1500ms and releases both query slots", async () => {
    vi.useFakeTimers()
    const requests: AbortSignal[] = []
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("tracks"))
        return new Response(
          "<TrackList><Track><id>101</id></Track></TrackList>"
        )
      if (
        String(init?.body).includes(
          "<startTime>2026-10-17T00:00:00Z</startTime>"
        )
      )
        return new Response(xml())
      const signal = init!.signal!
      requests.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("synthetic abort")),
          { once: true }
        )
      })
    })
    const service = new NvrService(config, new IsapiClient(config, fetcher))
    try {
      const result = await service.recordings("101", "2026-10-17")
      const pending = service.resolveSegment(
        "101",
        "2026-10-17",
        result.segments[0].id
      )
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      await expect(service.queryRaw("101", "2026-10-17")).rejects.toMatchObject(
        { code: "NVR_BUSY" }
      )
      await vi.advanceTimersByTimeAsync(1500)
      const resolved = await pending
      expect(resolved).not.toHaveProperty("estimatedDurationSeconds")
      expect(resolved.playbackURI).toBe(
        parseSearch(xml()).segments[0].playbackURI
      )
      expect(requests.every((signal) => signal.aborted)).toBe(true)
      const nextQueries = await Promise.all([
        service.queryRaw("101", "2026-10-17"),
        service.queryRaw("101", "2026-10-17"),
      ])
      expect(nextQueries.every((segments) => segments.length === 1)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    {
      name: "a failed neighbor search",
      neighbor: new Error("synthetic query failure"),
    },
    { name: "an empty neighbor search", neighbor: [] },
    {
      name: "a different file name",
      neighbor: [
        {
          ...previous,
          playbackURI: previous.playbackURI.replace(
            "synthetic-file",
            "other-file"
          ),
        },
      ],
    },
    {
      name: "a different file size",
      neighbor: [
        {
          ...previous,
          playbackURI: previous.playbackURI.replace("size=123", "size=456"),
        },
      ],
    },
    {
      name: "a different recording track",
      neighbor: [{ ...previous, trackId: "201" }],
    },
    {
      name: "a gap in the same file's intervals",
      neighbor: [{ ...previous, endAt: "2026-12-31T15:59:59Z" }],
    },
    {
      name: "a file still clipped at the outer query boundary",
      neighbor: [{ ...previous, startAt: "2026-12-30T16:00:00Z" }],
    },
    { name: "a repeated original-day result", neighbor: [source] },
    {
      name: "an untrusted neighbor URI",
      neighbor: [
        {
          ...previous,
          playbackURI: previous.playbackURI.replace(
            "nvr.test",
            "untrusted.test"
          ),
        },
      ],
    },
  ])(
    "keeps the original file playable without an estimate after $name",
    async ({ neighbor }) => {
      const { resolved } = await resolveFromDays(source, {
        [date]: [source],
        "2026-12-31": neighbor,
      })
      expect(resolved).toEqual(source)
      expect(resolved).not.toHaveProperty("estimatedDurationSeconds")
    }
  )

  it.each([
    "rtsp://nvr.test/Streaming/tracks/101/?name=synthetic-file",
    "rtsp://nvr.test/Streaming/tracks/101/?size=123",
    "rtsp://nvr.test/Streaming/tracks/101/?name=synthetic-file&name=ambiguous&size=123",
  ])(
    "omits the estimate when a boundary file has no unambiguous identity",
    async (playbackURI) => {
      const selected = { ...source, playbackURI }
      const { query, resolved } = await resolveFromDays(selected, {
        [date]: [selected],
      })
      expect(resolved).toEqual(selected)
      expect(query.mock.calls.map((call) => call[1])).toEqual([date])
    }
  )
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
