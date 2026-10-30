import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { PreviewSessions } from "../server/preview"
import { openRecordingDownload } from "../server/download"
import { splitFragmentedMp4 } from "../server/mp4"
import { remuxArguments } from "../server/remux"
import { readNvrConfig } from "../server/config"
import { createApp } from "../server/app"
import { NvrService } from "../server/recordings"
import type { RawSegment } from "../server/xml"
import { AppError } from "../server/errors"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test-user",
  NVR_PASSWORD: "test-secret",
})
const source: RawSegment = {
  trackId: "101",
  startAt: "2026-10-16T16:00:00Z",
  endAt: "2026-10-16T17:00:00Z",
  codec: "H.264-BP",
  playbackURI: "rtsp://nvr.test/Streaming/tracks/101/?name=synthetic&size=123",
}
const synthetic = readFileSync(
  new URL("../fixtures/synthetic-preview.mp4", import.meta.url)
)
const media = splitFragmentedMp4(synthetic)
const noAbort = () => new AbortController().signal

describe("download transport", () => {
  it("authenticates fixed POST endpoint, preserves and XML-escapes original URI", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Digest realm="test", nonce="n", qop="auth"',
          },
        })
      )
      .mockResolvedValueOnce(
        new Response("IMKH", {
          headers: { "content-type": "application/octet-stream" },
        })
      )
    const response = await openRecordingDownload(
      source.playbackURI,
      config,
      noAbort(),
      fetcher
    )
    expect(await response.text()).toBe("IMKH")
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, options] = fetcher.mock.calls[1]
    expect(url).toBe("http://nvr.test:80/ISAPI/ContentMgmt/download")
    expect(options).toMatchObject({ method: "POST", redirect: "manual" })
    expect(options?.body).toContain("&amp;size=123")
    expect(JSON.stringify(options)).not.toContain("test-secret")
    expect((options?.headers as Record<string, string>).Authorization).toMatch(
      /^Digest /
    )
  })
  it.each([302, 401, 403, 500])(
    "rejects upstream status %i without response details",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private upstream details", { status }))
      await expect(
        openRecordingDownload(source.playbackURI, config, noAbort(), fetcher)
      ).rejects.toBeInstanceOf(AppError)
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3)
    }
  )
  it("rejects XML success responses and arbitrary source hosts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("private xml", {
        headers: { "content-type": "application/xml" },
      })
    )
    await expect(
      openRecordingDownload(source.playbackURI, config, noAbort(), fetcher)
    ).rejects.toMatchObject({ code: "NVR_DOWNLOAD_FAILED" })
    fetcher.mockClear()
    await expect(
      openRecordingDownload(
        "rtsp://external.test/file",
        config,
        noAbort(),
        fetcher
      )
    ).rejects.toMatchObject({ code: "NVR_UNTRUSTED_URI" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("maps abort/network errors safely", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private network details"))
    await expect(
      openRecordingDownload(source.playbackURI, config, noAbort(), fetcher)
    ).rejects.toMatchObject({ code: "NVR_UNREACHABLE" })
    await expect(
      openRecordingDownload(
        source.playbackURI,
        config,
        AbortSignal.abort(),
        fetcher
      )
    ).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
  })
})
describe("copy-only container", () => {
  it("splits synthetic fMP4 and computes sample duration without decoding", () => {
    expect(media.codec).toBe("h264")
    expect(media.durationSeconds).toBeCloseTo(3)
    expect(media.init.subarray(4, 8).toString()).toBe("ftyp")
    expect(media.media.subarray(4, 8).toString()).toBe("moof")
    expect(Buffer.concat([media.init, media.media])).toEqual(synthetic)
  })
  it("recognizes genuine HEVC sample data independently of search metadata", () => {
    const hevc = readFileSync(
      new URL("../fixtures/synthetic-preview-hevc.mp4", import.meta.url)
    )
    expect(splitFragmentedMp4(hevc)).toMatchObject({
      codec: "hevc",
      durationSeconds: 3,
    })
    // Sample-entry structural cases; these variants are not browser decoding tests.
    for (const tag of ["hvc1", "hev1"]) {
      const variant = Buffer.from(hevc)
      const at = variant.indexOf("hev1")
      expect(at).toBeGreaterThan(0)
      variant.write(tag, at, "ascii")
      expect(splitFragmentedMp4(variant).codec).toBe("hevc")
    }
    const unsupported = Buffer.from(hevc)
    unsupported.write("vp09", unsupported.indexOf("hev1"), "ascii")
    expect(() => splitFragmentedMp4(unsupported)).toThrow(
      expect.objectContaining({ code: "MEDIA_UNSUPPORTED_CODEC" })
    )
  })
  it.each([
    Buffer.alloc(0),
    Buffer.from("truncated"),
    synthetic.subarray(0, 100),
    Buffer.from([0, 0, 0, 1, 109, 111, 111, 118, 255]),
  ])("rejects malformed container", (data) =>
    expect(() => splitFragmentedMp4(data)).toThrow(AppError)
  )
  it("uses stream copy with bounded duration and pipe transport", () => {
    const args = remuxArguments()
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual([
      "-c:v",
      "copy",
    ])
    expect(args).toContain("30")
    expect(args).toContain("pipe:0")
    expect(args).toContain("pipe:1")
    expect(args.join(" ")).not.toMatch(/libx264|libx265| -vf | -filter/)
  })
})
describe("preview lifecycle and API", () => {
  it("caps concurrency, expires and releases media", async () => {
    vi.useFakeTimers()
    const remux = vi.fn().mockResolvedValue(media),
      sessions = new PreviewSessions(remux, 100)
    try {
      const one = await sessions.create(config, async () => source, noAbort())
      const two = await sessions.create(config, async () => source, noAbort())
      await expect(
        sessions.create(config, async () => source, noAbort())
      ).rejects.toMatchObject({ code: "MEDIA_BUSY" })
      expect(sessions.playlist(one.id)).toContain("#EXT-X-ENDLIST")
      expect(sessions.playlist(one.id)).not.toContain("rtsp:")
      sessions.delete(one.id)
      expect(() => sessions.get(one.id)).toThrow()
      expect(sessions.get(two.id)).toBe(media)
      await vi.advanceTimersByTimeAsync(101)
      expect(() => sessions.get(two.id)).toThrow()
      await expect(
        sessions.create(config, async () => source, noAbort())
      ).resolves.toBeDefined()
    } finally {
      sessions.dispose()
      vi.useRealTimers()
    }
  })
  it("cancels a pending remux and releases its slot", async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const remux = vi.fn(
      (_uri, _config, signal: AbortSignal) =>
        new Promise<typeof media>((_resolve, reject) => {
          entered()
          signal.addEventListener(
            "abort",
            () => reject(new AppError("MEDIA_CANCELLED", 503, "已取消")),
            { once: true }
          )
        })
    )
    const sessions = new PreviewSessions(remux),
      controller = new AbortController()
    const pending = sessions.create(
      config,
      async () => source,
      controller.signal
    )
    await started
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "MEDIA_CANCELLED" })
    sessions.dispose()
  })
  it("uses actual media codec despite missing/incorrect search metadata, and rejects lookup failures", async () => {
    const remux = vi.fn().mockResolvedValue(media),
      sessions = new PreviewSessions(remux)
    const hevc = splitFragmentedMp4(
      readFileSync(
        new URL("../fixtures/synthetic-preview-hevc.mp4", import.meta.url)
      )
    )
    remux.mockResolvedValueOnce(hevc)
    await expect(
      sessions.create(config, async () => source, noAbort())
    ).resolves.toMatchObject({ codec: "hevc" })
    await expect(
      sessions.create(
        config,
        async () => ({ ...source, codec: undefined }),
        noAbort()
      )
    ).resolves.toMatchObject({ codec: "h264" })
    sessions.dispose()
    await expect(
      sessions.create(
        config,
        async () => {
          throw new AppError("RECORDING_NOT_FOUND", 404, "未找到")
        },
        noAbort()
      )
    ).rejects.toMatchObject({ code: "RECORDING_NOT_FOUND" })
    expect(remux).toHaveBeenCalledTimes(2)
    sessions.dispose()
  })
  it("exposes only opaque, same-origin assets; validates mutations and deletes", async () => {
    const service = new NvrService(config),
      resolve = vi.spyOn(service, "resolveSegment").mockResolvedValue(source)
    const sessions = new PreviewSessions(vi.fn().mockResolvedValue(media)),
      app = createApp(() => service, sessions)
    const body = { track: "101", date: "2026-10-17", segmentId: "a".repeat(32) }
    const post = (value: unknown, headers: Record<string, string> = {}) =>
      app.request("/api/streams/playback", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(value),
      })
    try {
      expect((await post({ ...body, url: source.playbackURI })).status).toBe(
        400
      )
      expect(
        (await post(body, { origin: "http://external.test" })).status
      ).toBe(403)
      expect((await post({ track: "101" })).status).toBe(400)
      expect(
        (
          await post(
            {},
            { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" }
          )
        ).status
      ).toBe(400)
      expect(
        (await post({ ...body, segmentId: "a".repeat(2000) })).status
      ).toBe(400)
      const response = await post(body),
        json = await response.json()
      expect(response.status).toBe(201)
      expect(JSON.stringify(json)).not.toMatch(
        /rtsp:|nvr.test|test-secret|playbackURI/
      )
      expect(resolve).toHaveBeenCalledExactlyOnceWith(
        body.track,
        body.date,
        body.segmentId,
        undefined
      )
      expect(
        (await app.request(json.playlistUrl)).headers.get("cache-control")
      ).toBe("no-store")
      const playlist = await (await app.request(json.playlistUrl)).text()
      expect(playlist).toContain('URI="init.mp4"')
      for (const asset of ["init.mp4", "segment.m4s"])
        expect(
          (await app.request(`/api/streams/${json.id}/${asset}`)).status
        ).toBe(200)
      expect((await app.request(`/api/streams/${json.id}/other`)).status).toBe(
        404
      )
      expect(
        (await app.request(`/api/streams/${json.id}`, { method: "DELETE" }))
          .status
      ).toBe(204)
      expect((await app.request(json.playlistUrl)).status).toBe(404)
    } finally {
      sessions.dispose()
    }
  })
  it("resolves only server-issued segment IDs for the selected track/day", async () => {
    const service = new NvrService(config)
    vi.spyOn(service, "queryRaw").mockResolvedValue([source])
    const result = await service.recordings("101", "2026-10-17")
    await expect(
      service.resolveSegment("101", "2026-10-17", result.segments[0].id)
    ).resolves.toEqual(source)
    await expect(
      service.resolveSegment("101", "2026-10-17", "0".repeat(32))
    ).rejects.toMatchObject({ code: "RECORDING_NOT_FOUND" })
  })
})
