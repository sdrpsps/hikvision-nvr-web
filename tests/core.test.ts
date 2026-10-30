import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import {
  parseDevice,
  parseTracks,
  parseSearch,
  buildSearch,
} from "../server/xml"
import { coverageAndGaps, dayRange } from "../server/time"
import { parseChallenge, digestAuthorization } from "../server/digest"
import { IsapiClient } from "../server/isapi"
import { readNvrConfig } from "../server/config"
import { NvrService, validatePlaybackUri } from "../server/recordings"
import { createApp } from "../server/app"
import { AppError } from "../server/errors"
import { summarizeTrace, probeMedia } from "../server/rtsp-diagnostics"

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}.xml`, import.meta.url), "utf8")
const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test-user",
  NVR_PASSWORD: "test-secret",
  NVR_RECORDING_TIME_MODE: "utc",
})

describe("XML contract", () => {
  it("returns only public device fields", () =>
    expect(parseDevice(fixture("device"))).toEqual({
      model: "TEST-NVR",
      firmware: "TEST-FIRMWARE",
    }))
  it("handles namespaces and keeps disabled tracks", () =>
    expect(parseTracks(fixture("tracks"))).toEqual([
      { id: "101", name: "轨道 101", configuredEnabled: false },
      { id: "201", name: "测试通道", configuredEnabled: true },
    ]))
  it("preserves the decoded original URI and metadata", () => {
    const search = parseSearch(fixture("search"))
    expect(search.segments).toHaveLength(2)
    expect(search.segments[0].playbackURI).toContain(
      "/101/?starttime=20261016T160000Z&endtime=20261016T170000Z&name=synthetic-one&size=123"
    )
    expect(search.segments[0].codec).toBe("H.264-BP")
  })
  it("accepts empty and prefixed responses", () => {
    expect(parseSearch(fixture("empty")).segments).toEqual([])
    expect(
      parseDevice(
        '<h:DeviceInfo xmlns:h="test"><h:model>A</h:model><h:firmwareVersion>B</h:firmwareVersion></h:DeviceInfo>'
      )
    ).toEqual({ model: "A", firmware: "B" })
  })
  it.each([
    "<bad>",
    "<DeviceInfo/>",
    '<!DOCTYPE x [<!ENTITY a "secret">]><DeviceInfo/>',
  ])("rejects invalid/unsafe XML", (xml) =>
    expect(() => parseDevice(xml)).toThrow()
  )
  it("rejects missing times and false status instead of inventing empty results", () => {
    expect(() =>
      parseSearch(
        fixture("search").replace(
          "<startTime>2026-10-16T16:00:00Z</startTime>",
          ""
        )
      )
    ).toThrow()
    expect(() =>
      parseSearch(
        fixture("empty").replace(
          "<responseStatus>true",
          "<responseStatus>false"
        )
      )
    ).toThrow()
  })
  it("uses verified vendor spelling without metadataList", () => {
    const body = buildSearch(
      "101",
      "2026-10-16T16:00:00Z",
      "2026-10-17T15:59:59Z",
      "test",
      40
    )
    expect(body).toContain("<searchResultPostion>40</searchResultPostion>")
    expect(body).not.toMatch(/searchResultPosition|metadataList/)
  })
})

describe("device calendar and coverage", () => {
  it("queries Beijing midnight independently of host time zone", () =>
    expect(dayRange("2026-10-17", "Asia/Shanghai")).toEqual({
      startAt: "2026-10-16T16:00:00Z",
      endAt: "2026-10-17T16:00:00Z",
    }))
  it.each([
    ["2026-03-08", 23],
    ["2026-11-01", 25],
  ] as const)("handles DST day %s", (date, hours) => {
    const range = dayRange(date, "America/New_York")
    expect(Date.parse(range.endAt) - Date.parse(range.startAt)).toBe(
      hours * 3600000
    )
  })
  it("merges overlap/adjacency, clips midnight and retains gaps", () => {
    const range = {
      startAt: "2026-10-17T00:00:00Z",
      endAt: "2026-10-18T00:00:00Z",
    }
    const result = coverageAndGaps(
      [
        { startAt: "2026-10-16T23:00:00Z", endAt: "2026-10-17T01:00:00Z" },
        { startAt: "2026-10-17T00:30:00Z", endAt: "2026-10-17T02:00:00Z" },
        { startAt: "2026-10-17T02:00:00Z", endAt: "2026-10-17T03:00:00Z" },
        { startAt: "2026-10-17T04:00:00Z", endAt: "2026-10-18T01:00:00Z" },
      ],
      range
    )
    expect(result.coverage).toHaveLength(2)
    expect(result.gaps).toEqual([
      {
        startAt: "2026-10-17T03:00:00.000Z",
        endAt: "2026-10-17T04:00:00.000Z",
      },
    ])
    expect(coverageAndGaps([], range).gaps).toEqual([
      {
        startAt: "2026-10-17T00:00:00.000Z",
        endAt: "2026-10-18T00:00:00.000Z",
      },
    ])
  })
})

describe("Digest transport", () => {
  it("matches RFC 2617 digest example", () => {
    const challenge = parseChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"'
    )
    expect(
      digestAuthorization(
        challenge,
        "Mufasa",
        "Circle Of Life",
        "GET",
        "/dir/index.html",
        "0a4f113b"
      )
    ).toContain('response="6629fae49393a05397450978507c4ef1"')
  })
  it("rejects unsupported challenges", () => {
    expect(() => parseChallenge('Basic realm="test"')).toThrow()
    expect(() =>
      parseChallenge('Digest realm="test", nonce="x", qop="auth-int"')
    ).toThrow()
  })
  it("challenges then retries authenticated, without following redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Digest realm="test",nonce="abc",qop="auth"',
          },
        })
      )
      .mockResolvedValueOnce(new Response("<ok/>"))
    expect(
      await new IsapiClient(config, fetcher).request("/ISAPI/System/deviceInfo")
    ).toBe("<ok/>")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty(
      "Authorization"
    )
    expect(fetcher.mock.calls[1][1]?.headers).toHaveProperty("Authorization")
    expect(fetcher.mock.calls[1][1]?.redirect).toBe("manual")
  })
  it("bounds failed authentication and supports one stale nonce retry", async () => {
    const unauthorized = () =>
      new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": 'Digest realm="test",nonce="abc"' },
      })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => unauthorized())
    await expect(
      new IsapiClient(config, fetcher).request("/ISAPI/System/deviceInfo")
    ).rejects.toMatchObject({ code: "NVR_AUTH_FAILED" })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const stale = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Digest realm="test",nonce="def",stale=true',
          },
        })
      )
      .mockResolvedValueOnce(new Response("ok"))
    await expect(
      new IsapiClient(config, stale).request("/ISAPI/System/deviceInfo")
    ).resolves.toBe("ok")
    expect(stale).toHaveBeenCalledTimes(3)
  })
  it.each([
    [403, "NVR_FORBIDDEN"],
    [503, "NVR_HTTP_ERROR"],
    [302, "NVR_HTTP_ERROR"],
  ] as const)("converts status %s", async (status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status }))
    await expect(
      new IsapiClient(config, fetcher).request("/ISAPI/System/deviceInfo")
    ).rejects.toMatchObject({ code })
  })
  it("converts network failures without exposing upstream text", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("password=SECRET"))
    await expect(
      new IsapiClient(config, fetcher).request("/ISAPI/System/deviceInfo")
    ).rejects.toMatchObject({ code: "NVR_UNREACHABLE" })
  })
  it("times out a hung request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted"))
            )
          )
      )
    await expect(
      new IsapiClient({ ...config, NVR_TIMEOUT_MS: 20 }, fetcher).request(
        "/ISAPI/System/deviceInfo"
      )
    ).rejects.toMatchObject({ code: "NVR_TIMEOUT" })
  })
})

function mockedService(pages = [fixture("search")]) {
  let page = 0
  const client = {
    request: vi.fn(async (path: string) =>
      path.endsWith("tracks")
        ? fixture("tracks")
        : path.endsWith("deviceInfo")
          ? fixture("device")
          : pages[page++]
    ),
  }
  return {
    service: new NvrService(config, client as unknown as IsapiClient),
    client,
  }
}
describe("search pagination and API privacy", () => {
  it("deduplicates pagination boundaries while keeping distinct adjacent segments", async () => {
    const { service, client } = mockedService([
      fixture("search").replace(
        "<responseStatusStrg>OK",
        "<responseStatusStrg>MORE"
      ),
      fixture("search"),
    ])
    const result = await service.recordings("101", "2026-10-17")
    expect(result.segments).toHaveLength(2)
    expect(result.coverage).toHaveLength(1)
    const requests = client.request.mock.calls as unknown as [string, string][]
    expect(requests[1][1]).toContain("<endTime>2026-10-17T15:59:59Z</endTime>")
    expect(requests[2][1]).toContain(
      "<searchResultPostion>2</searchResultPostion>"
    )
    expect(JSON.stringify(result)).not.toMatch(
      /playbackURI|rtsp:|synthetic-one/
    )
    await service.recordings("101", "2026-10-17")
    expect(client.request).toHaveBeenCalledTimes(3)
  })
  it("rejects stalled pagination, foreign tracks, and foreign URI", async () => {
    const more = fixture("search").replace(
      "<responseStatusStrg>OK",
      "<responseStatusStrg>MORE"
    )
    await expect(
      mockedService([more, more]).service.recordings("101", "2026-10-17")
    ).rejects.toMatchObject({ code: "NVR_PAGINATION_STALLED" })
    await expect(
      mockedService([
        fixture("search").replaceAll("<trackID>101", "<trackID>201"),
      ]).service.recordings("101", "2026-10-17")
    ).rejects.toMatchObject({ code: "NVR_TRACK_MISMATCH" })
    await expect(
      mockedService([
        fixture("search").replaceAll("nvr.test", "other.test"),
      ]).service.recordings("101", "2026-10-17")
    ).rejects.toMatchObject({ code: "NVR_UNTRUSTED_URI" })
  })
  it("returns empty results and rejects nonexistent tracks", async () => {
    expect(
      (
        await mockedService([fixture("empty")]).service.recordings(
          "101",
          "2026-10-17"
        )
      ).segments
    ).toHaveLength(0)
    await expect(
      mockedService().service.recordings("999", "2026-10-17")
    ).rejects.toMatchObject({ code: "TRACK_NOT_FOUND" })
  })
  it.each([
    "http://nvr.test/",
    "rtsp://other.test/",
    "rtsp://user:pass@nvr.test/",
    "rtsp://nvr.test:555/",
    "rtsp://nvr.test/path\nheader",
  ])("rejects untrusted URI", (uri) =>
    expect(() => validatePlaybackUri(uri, config)).toThrow()
  )
  it("health never connects to the device", async () => {
    const getService = vi.fn(() => {
      throw new Error("secret")
    })
    const app = createApp(getService)
    expect(await (await app.request("/api/health")).json()).toEqual({
      status: "ok",
    })
    expect(getService).not.toHaveBeenCalled()
  })
  it.each([
    "track=../101&date=2026-10-17",
    "track=101&date=2026-02-30",
    "track=101&date=2026-10-17&url=rtsp://other.test",
    "track=101&date=2026-10-17&track=201",
  ])("rejects invalid or extra parameters before NVR access", async (query) => {
    const getService = vi.fn(() => mockedService().service)
    expect(
      (await createApp(getService).request(`/api/recordings?${query}`)).status
    ).toBe(400)
    expect(getService).not.toHaveBeenCalled()
  })
  it("serves validated public DTOs and safe errors", async () => {
    const app = createApp(() => mockedService().service)
    const device = await app.request("/api/device")
    expect(await device.text()).not.toMatch(/PRIVATE|serial|macAddress/)
    const response = await app.request(
      "/api/recordings?track=101&date=2026-10-17"
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).not.toMatch(
      /rtsp:|playbackURI|test-secret|nvr.test/
    )
    const missing = createApp(() => {
      throw new AppError("NVR_TIMEOUT", 504, "设备查询超时。")
    })
    expect((await missing.request("/api/device")).status).toBe(504)
    const unexpected = createApp(() => {
      throw new Error("password=secret")
    })
    expect(await (await unexpected.request("/api/device")).text()).not.toMatch(
      /password|secret/
    )
  })
})

describe("diagnostic safety", () => {
  it("reduces raw traces to method/status only", () => {
    const result = summarizeTrace(
      'OPTIONS rtsp://user:pass@nvr.test/private RTSP/1.0\nRTSP/1.0 401 Unauthorized\nWWW-Authenticate: Digest realm="private",nonce="secret"\nDESCRIBE rtsp://private RTSP/1.0\nRTSP/1.0 400 Bad Request'
    )
    expect(result).toEqual({
      stages: [
        { method: "OPTIONS", status: 401 },
        { method: "DESCRIBE", status: 400 },
      ],
      challenges: ["Digest"],
    })
    expect(JSON.stringify(result)).not.toMatch(/pass|nonce|private/)
  })
  it("reports a missing tool without throwing raw process errors", async () => {
    const result = await probeMedia(
      "rtsp://nvr.test/Streaming/tracks/101/?name=private",
      config,
      {
        tool: "ffprobe",
        transport: "tcp",
        auth: "credentials",
        executable: "/nonexistent/nvr-test-tool",
      }
    )
    expect(result.unavailable).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/private|test-secret/)
  })
})

describe("query limits and cleanup", () => {
  it("releases cancelled query slots while a shared channel lookup is still pending", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = {
      request: vi.fn(async (path: string) => {
        if (path.endsWith("tracks")) await gate
        return path.endsWith("tracks") ? fixture("tracks") : fixture("empty")
      }),
    }
    const service = new NvrService(config, client as unknown as IsapiClient)
    const first = new AbortController(),
      second = new AbortController()
    const one = service.queryRaw("101", "2026-10-17", first.signal)
    const two = service.queryRaw("201", "2026-10-17", second.signal)
    const rejectedOne = expect(one).rejects.toMatchObject({
      name: "AbortError",
    })
    const rejectedTwo = expect(two).rejects.toMatchObject({
      name: "AbortError",
    })
    first.abort()
    second.abort()
    await Promise.all([rejectedOne, rejectedTwo])
    const latest = service.queryRaw("101", "2026-10-17")
    release()
    await expect(latest).resolves.toEqual([])
    expect(
      client.request.mock.calls.filter(([path]) => path.endsWith("tracks"))
    ).toHaveLength(1)
  })

  it("passes cancellation to search requests and frees both slots for the latest target", async () => {
    const requests: AbortSignal[] = []
    let block = true
    const client = {
      request: vi.fn(
        async (path: string, _body?: string, signal?: AbortSignal) => {
          if (path.endsWith("tracks")) return fixture("tracks")
          if (!path.endsWith("search") || !block) return fixture("empty")
          requests.push(signal!)
          return new Promise<string>((_resolve, reject) => {
            const abort = () => reject(signal!.reason)
            signal!.addEventListener("abort", abort, { once: true })
            if (signal!.aborted) abort()
          })
        }
      ),
    }
    const service = new NvrService(config, client as unknown as IsapiClient)
    const first = new AbortController(),
      second = new AbortController()
    const one = service.queryRaw("101", "2026-10-17", first.signal)
    const two = service.queryRaw("201", "2026-10-17", second.signal)
    const rejectedOne = expect(one).rejects.toMatchObject({
      name: "AbortError",
    })
    const rejectedTwo = expect(two).rejects.toMatchObject({
      name: "AbortError",
    })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    first.abort()
    second.abort()
    await Promise.all([rejectedOne, rejectedTwo])
    expect(requests.every((signal) => signal.aborted)).toBe(true)
    block = false
    await expect(service.queryRaw("101", "2026-10-17")).resolves.toEqual([])
  })

  it("coalesces identical simultaneous searches", async () => {
    const { service, client } = mockedService()
    const [first, second] = await Promise.all([
      service.recordings("101", "2026-10-17"),
      service.recordings("101", "2026-10-17"),
    ])
    expect(first).toEqual(second)
    expect(client.request).toHaveBeenCalledTimes(2)
  })
  it("limits concurrent searches and releases slots after failures", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = {
      request: vi.fn(async (path: string) => {
        await gate
        return path.endsWith("tracks") ? fixture("tracks") : fixture("empty")
      }),
    }
    const service = new NvrService(config, client as unknown as IsapiClient)
    const first = service.queryRaw("101", "2026-10-17"),
      second = service.queryRaw("201", "2026-10-17")
    await expect(service.queryRaw("101", "2026-10-16")).rejects.toMatchObject({
      code: "NVR_BUSY",
    })
    release()
    await Promise.all([first, second])
    await expect(service.queryRaw("101", "2026-10-16")).resolves.toEqual([])
  })
  it("expires short-lived caches", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000)
    try {
      const { service, client } = mockedService([
        fixture("empty"),
        fixture("empty"),
      ])
      await service.recordings("101", "2026-10-17")
      now.mockReturnValue(32000)
      await service.recordings("101", "2026-10-17")
      expect(client.request).toHaveBeenCalledTimes(4)
    } finally {
      now.mockRestore()
    }
  })
  it("keeps explicit UTC metadata without generating time-verification notices", async () => {
    const { service } = mockedService([
      fixture("search").replaceAll("2026-10-16", "2099-10-16"),
    ])
    const result = await service.recordings("101", "2099-10-17")
    expect(result.warnings).toEqual([])
    expect(result.segments[0].startAt).toBe("2099-10-16T16:00:00.000Z")
  })
  it("kills a timed-out diagnostic child and removes its private manifest", async () => {
    const { mkdtemp, writeFile, rm, readdir } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const folder = await mkdtemp(join(tmpdir(), "nvr-fake-test-")),
      executable = join(folder, "fake-tool")
    const before = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("nvr-rtsp-")
    )
    try {
      await writeFile(
        executable,
        "#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n",
        { mode: 0o700 }
      )
      const result = await probeMedia(
        "rtsp://nvr.test/Streaming/tracks/101/",
        config,
        {
          tool: "ffmpeg",
          transport: "tcp",
          auth: "credentials",
          executable,
          timeoutMs: 200,
        }
      )
      expect(result.timedOut).toBe(true)
      expect(result.decodedFrames).toBe(0)
      expect(
        (await readdir(tmpdir())).filter((name) => name.startsWith("nvr-rtsp-"))
      ).toEqual(before)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
