import { describe, expect, it, vi } from "vitest"
import { readNvrConfig } from "../server/config"
import { AppError } from "../server/errors"
import { IsapiClient } from "../server/isapi"
import { PlaybackCapabilities } from "../server/playback-capabilities"

const SDK_PATH = "/SDK/capabilities"
const SYSTEM_PATH = "/ISAPI/System/capabilities"
const TRACKS_PATH = "/ISAPI/ContentMgmt/record/tracks"
const sdk = (value = "33") =>
  `<SdkCap><isSupportHttpPlayback>true</isSupportHttpPlayback><ipChanBase>${value}</ipChanBase></SdkCap>`
const system = (value = "0") =>
  `<DeviceCap><SysCap><VideoCap><videoInputPortNums>${value}</videoInputPortNums></VideoCap></SysCap></DeviceCap>`
const track = (id: string, source?: string) =>
  `<Track><id>${id}</id><Enable>false</Enable>${source === undefined ? "" : `<SrcDescriptor><SrcChannel>${source}</SrcChannel><SrcUrl>private-source</SrcUrl></SrcDescriptor>`}</Track>`
const tracks = (...items: string[]) =>
  `<TrackList>${items.join("")}</TrackList>`

function setup(
  options: { sdk?: string; system?: string; tracks?: string } = {}
) {
  const responses: Record<string, string> = {
    [SDK_PATH]: options.sdk ?? sdk(),
    [SYSTEM_PATH]: options.system ?? system(),
    [TRACKS_PATH]:
      options.tracks ?? tracks(track("101", "1"), track("102", "1")),
  }
  const request = vi.fn<IsapiClient["request"]>(async (path) => {
    if (!(path in responses)) throw new Error("Unexpected mock path")
    return responses[path]
  })
  return { request, capabilities: new PlaybackCapabilities({ request }) }
}

describe("trusted SHTTP playback channel mapping", () => {
  it("maps canonical digital main/sub streams using the advertised channel base", async () => {
    const { capabilities, request } = setup({
      tracks: tracks(track("101", "1"), track("102", "1"), track("201", "2")),
    })
    expect(await capabilities.forTrack("101")).toEqual({
      nativeChannel: 33,
      streamIndex: 0,
    })
    expect(await capabilities.forTrack("102")).toEqual({
      nativeChannel: 33,
      streamIndex: 1,
    })
    expect(await capabilities.forTrack("201")).toEqual({
      nativeChannel: 34,
      streamIndex: 0,
    })
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      SDK_PATH,
      SYSTEM_PATH,
      TRACKS_PATH,
    ])
  })

  it("keeps analog IDs and offsets digital IDs after the analog inputs", async () => {
    const { capabilities } = setup({
      sdk: sdk("65"),
      system: system("2"),
      tracks: tracks(
        track("101", "1"),
        track("201", "2"),
        track("301", "3"),
        track("402", "4")
      ),
    })
    for (const [id, nativeChannel, streamIndex] of [
      ["101", 1, 0],
      ["201", 2, 0],
      ["301", 65, 0],
      ["402", 66, 1],
    ] as const)
      expect(await capabilities.forTrack(id)).toEqual({
        nativeChannel,
        streamIndex,
      })
  })

  it("parses namespace prefixes, attributes and built-in entities without exposing device fields", async () => {
    const { capabilities } = setup({
      sdk: '<?xml version="1.0" encoding="UTF-8"?><n:SdkCap xmlns:n="urn:test" version="1.0"><n:isSupportHttpPlayback>true</n:isSupportHttpPlayback><n:ipChanBase min="1" max="65535">&#51;&#51;</n:ipChanBase><n:serialNumber>private-serial</n:serialNumber></n:SdkCap>',
      system:
        '<n:DeviceCap xmlns:n="urn:test"><n:SysCap><n:VideoCap><n:videoInputPortNums>0</n:videoInputPortNums></n:VideoCap></n:SysCap></n:DeviceCap>',
      tracks:
        '<n:TrackList xmlns:n="urn:test"><n:Track><n:id>101</n:id><n:SrcDescriptor><n:SrcChannel>1</n:SrcChannel></n:SrcDescriptor></n:Track></n:TrackList>',
    })
    expect(await capabilities.forTrack("101")).toEqual({
      nativeChannel: 33,
      streamIndex: 0,
    })
  })

  it.each([
    ["701", tracks(track("701", "1"))],
    ["101", tracks(track("101", "2"))],
    ["101", tracks(track("101"))],
    ["101", tracks(track("101", "url"))],
    ["101", tracks(track("101", "01"))],
    ["101", tracks(track("101", "1"), track("101", "1"))],
    ["101", tracks(track("101", "1"), track("101", "2"))],
    ["101", tracks(track("201", "2"))],
    ["101", "<TrackList/>"],
  ])(
    "declines missing, aliased or ambiguous mappings for %s",
    async (id, xml) => {
      expect(
        await setup({ tracks: xml }).capabilities.forTrack(id)
      ).toBeUndefined()
    }
  )

  it.each([
    "1",
    "99",
    "100",
    "103",
    "0101",
    "-101",
    "101?host=other",
    "101\n",
    "6553601",
    "999999999",
  ])("does not query for an unsupported track encoding: %s", async (id) => {
    const { capabilities, request } = setup()
    expect(await capabilities.forTrack(id)).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects native channel arithmetic outside the transport range", async () => {
    const { capabilities, request } = setup({
      sdk: sdk("65535"),
      tracks: tracks(track("201", "2")),
    })
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(capabilities.forTrack("201")).rejects.toMatchObject({
        code: "NVR_INVALID_XML",
      })
    expect(request).toHaveBeenCalledTimes(6)
  })
})

describe("playback capability parsing and failures", () => {
  it.each([
    "<SdkCap/>",
    "<SdkCap><isSupportHttpPlayback>false</isSupportHttpPlayback></SdkCap>",
    `<SdkCap><isSupportHttpPlayback>false</isSupportHttpPlayback><ipChanBase>not-used</ipChanBase></SdkCap>`,
  ])(
    "caches an absent or explicitly unsupported advertisement",
    async (xml) => {
      const { capabilities, request } = setup({ sdk: xml })
      expect(await capabilities.forTrack("101")).toBeUndefined()
      expect(await capabilities.forTrack("102")).toBeUndefined()
      expect(request).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    "<broken>",
    "<Other/>",
    '<!DOCTYPE SdkCap [<!ENTITY x "true">]><SdkCap><isSupportHttpPlayback>&x;</isSupportHttpPlayback></SdkCap>',
    "<SdkCap/><SdkCap/>",
    `${sdk()}<Other/>`,
    "<SdkCap><isSupportHttpPlayback>true</isSupportHttpPlayback><isSupportHttpPlayback>false</isSupportHttpPlayback></SdkCap>",
    "<SdkCap><isSupportHttpPlayback>TRUE</isSupportHttpPlayback></SdkCap>",
    "<SdkCap><isSupportHttpPlayback>1</isSupportHttpPlayback></SdkCap>",
    "<SdkCap><isSupportHttpPlayback/></SdkCap>",
    "<SdkCap><isSupportHttpPlayback>true</isSupportHttpPlayback></SdkCap>",
    sdk("0"),
    sdk("-1"),
    sdk("1.5"),
    sdk("033"),
    sdk("3e1"),
    sdk("65536"),
    sdk("4294967296"),
    "<SdkCap><isSupportHttpPlayback>true</isSupportHttpPlayback><ipChanBase>33</ipChanBase><ipChanBase>34</ipChanBase></SdkCap>",
  ])("rejects malformed or ambiguous SDK capabilities", async (xml) => {
    const { capabilities, request } = setup({ sdk: xml })
    await expect(capabilities.forTrack("101")).rejects.toMatchObject({
      code: "NVR_INVALID_XML",
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    "<DeviceCap/>",
    "<DeviceCap><VideoCap><videoInputPortNums>0</videoInputPortNums></VideoCap></DeviceCap>",
    "<DeviceCap><SysCap><VideoCap/></SysCap></DeviceCap>",
    "<!DOCTYPE DeviceCap><DeviceCap><SysCap><VideoCap><videoInputPortNums>0</videoInputPortNums></VideoCap></SysCap></DeviceCap>",
    "<DeviceCap><SysCap><VideoCap><videoInputPortNums>0</videoInputPortNums><videoInputPortNums>1</videoInputPortNums></VideoCap></SysCap></DeviceCap>",
    system("-1"),
    system("0.0"),
    system("65536"),
  ])(
    "rejects unsafe analog channel metadata after a true advertisement",
    async (xml) => {
      const { capabilities, request } = setup({ system: xml })
      await expect(capabilities.forTrack("101")).rejects.toMatchObject({
        code: "NVR_INVALID_XML",
      })
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it("rejects malformed tracks without caching the failure", async () => {
    const { capabilities, request } = setup({ tracks: "<invalid/>" })
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(capabilities.forTrack("101")).rejects.toMatchObject({
        code: "NVR_INVALID_XML",
      })
    expect(request).toHaveBeenCalledTimes(6)
  })

  it("caches unsupported SDK endpoint errors and permits a new lookup after expiry", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000)
    const { capabilities, request } = setup()
    request.mockRejectedValueOnce(
      new AppError("NVR_HTTP_ERROR", 502, "unsupported")
    )
    try {
      expect(await capabilities.forTrack("101")).toBeUndefined()
      expect(await capabilities.forTrack("101")).toBeUndefined()
      expect(request).toHaveBeenCalledTimes(1)
      now.mockReturnValue(21000)
      expect(await capabilities.forTrack("101")).toEqual({
        nativeChannel: 33,
        streamIndex: 0,
      })
      expect(request).toHaveBeenCalledTimes(4)
    } finally {
      now.mockRestore()
    }
  })

  it.each([
    "NVR_AUTH_FAILED",
    "NVR_FORBIDDEN",
    "NVR_TIMEOUT",
    "NVR_UNREACHABLE",
  ])("does not hide or cache SDK query failures: %s", async (code) => {
    const { capabilities, request } = setup()
    const error = new AppError(code, 502, "safe device error")
    request.mockRejectedValueOnce(error)
    await expect(capabilities.forTrack("101")).rejects.toBe(error)
    expect(await capabilities.forTrack("101")).toEqual({
      nativeChannel: 33,
      streamIndex: 0,
    })
    expect(request).toHaveBeenCalledTimes(4)
  })

  it.each([SYSTEM_PATH, TRACKS_PATH])(
    "does not turn an advertised service query failure into a fallback: %s",
    async (failedPath) => {
      const error = new AppError("NVR_HTTP_ERROR", 502, "safe device error")
      const request = vi.fn<IsapiClient["request"]>(async (path) => {
        if (path === failedPath) throw error
        return path === SDK_PATH ? sdk() : system()
      })
      const capabilities = new PlaybackCapabilities({ request })
      await expect(capabilities.forTrack("101")).rejects.toBe(error)
    }
  )
})

describe("playback capability cache and cancellation", () => {
  it("expires successful metadata after 20 seconds and does not expose mutable cache objects", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000)
    const { capabilities, request } = setup()
    try {
      const first = await capabilities.forTrack("101")
      if (first) first.nativeChannel = 999
      now.mockReturnValue(20999)
      expect(await capabilities.forTrack("101")).toEqual({
        nativeChannel: 33,
        streamIndex: 0,
      })
      expect(request).toHaveBeenCalledTimes(3)
      now.mockReturnValue(21000)
      await capabilities.forTrack("101")
      expect(request).toHaveBeenCalledTimes(6)
    } finally {
      now.mockRestore()
    }
  })

  it("honors an already canceled caller before querying or returning cached data", async () => {
    const { capabilities, request } = setup()
    const reason = new Error("caller canceled")
    const signal = AbortSignal.abort(reason)
    await expect(capabilities.forTrack("101", signal)).rejects.toBe(reason)
    expect(request).not.toHaveBeenCalled()
    await capabilities.forTrack("101")
    await expect(capabilities.forTrack("101", signal)).rejects.toBe(reason)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it.each([SDK_PATH, SYSTEM_PATH, TRACKS_PATH])(
    "does not cache a canceled lookup even if the upstream ignores its signal: %s",
    async (canceledPath) => {
      const { capabilities, request } = setup()
      const controller = new AbortController()
      const reason = new Error("caller canceled")
      const normal = request.getMockImplementation()!
      request.mockImplementation(async (...args) => {
        const xml = await normal(...args)
        expect(args[2]).toBe(controller.signal)
        if (args[0] === canceledPath) controller.abort(reason)
        return xml
      })
      await expect(
        capabilities.forTrack("101", controller.signal)
      ).rejects.toBe(reason)
      expect(request).toHaveBeenCalledTimes(
        [SDK_PATH, SYSTEM_PATH, TRACKS_PATH].indexOf(canceledPath) + 1
      )
      request.mockImplementation(normal)
      expect(await capabilities.forTrack("101")).toEqual({
        nativeChannel: 33,
        streamIndex: 0,
      })
    }
  )

  it("does not cache an unsupported response when its caller was canceled", async () => {
    const { capabilities, request } = setup()
    const controller = new AbortController()
    const reason = new Error("caller canceled")
    request.mockImplementationOnce(async () => {
      controller.abort(reason)
      throw new AppError("NVR_HTTP_ERROR", 502, "unsupported")
    })
    await expect(capabilities.forTrack("101", controller.signal)).rejects.toBe(
      reason
    )
    expect(await capabilities.forTrack("101")).toEqual({
      nativeChannel: 33,
      streamIndex: 0,
    })
    expect(request).toHaveBeenCalledTimes(4)
  })

  it("keeps concurrent caller cancellation separate without a shared request", async () => {
    const { capabilities, request } = setup()
    const controller = new AbortController()
    const reason = new Error("first caller canceled")
    request.mockImplementationOnce(
      (_path, _body, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        })
    )
    const canceled = capabilities.forTrack("101", controller.signal)
    const surviving = capabilities.forTrack("102")
    controller.abort(reason)
    await expect(canceled).rejects.toBe(reason)
    await expect(surviving).resolves.toEqual({
      nativeChannel: 33,
      streamIndex: 1,
    })
    expect(request).toHaveBeenCalledTimes(4)
    expect(await capabilities.forTrack("101")).toEqual({
      nativeChannel: 33,
      streamIndex: 0,
    })
    expect(request).toHaveBeenCalledTimes(4)
  })
})

describe("read-only playback capability device paths", () => {
  const config = readNvrConfig({
    NVR_HOST: "nvr.test",
    NVR_USERNAME: "test-user",
    NVR_PASSWORD: "test-password",
  })

  it.each([SDK_PATH, SYSTEM_PATH])(
    "only permits exact GET queries: %s",
    async (path) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("<ok/>"))
      const client = new IsapiClient(config, fetcher)
      expect(await client.request(path)).toBe("<ok/>")
      expect(fetcher).toHaveBeenCalledWith(
        `http://nvr.test:80${path}`,
        expect.objectContaining({
          method: "GET",
          redirect: "manual",
          body: undefined,
        })
      )
      for (const body of ["", "<request/>"])
        await expect(client.request(path, body)).rejects.toMatchObject({
          code: "INVALID_DEVICE_PATH",
        })
      await expect(
        client.request(path, "<request/>", undefined, "PUT")
      ).rejects.toMatchObject({ code: "INVALID_DEVICE_PATH" })
      for (const suffix of ["/", "?other=1", "/../settings"])
        await expect(client.request(path + suffix)).rejects.toMatchObject({
          code: "INVALID_DEVICE_PATH",
        })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )
})
