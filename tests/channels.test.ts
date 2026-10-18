import { describe, expect, it, vi } from "vitest"
import { parseInputProxyNames, parseTracks } from "../server/xml"
import { NvrService } from "../server/recordings"
import { readNvrConfig } from "../server/config"
import type { IsapiClient } from "../server/isapi"
import { AppError } from "../server/errors"
import { createApp } from "../server/app"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test-user",
  NVR_PASSWORD: "test-secret",
})
const tracks = `<TrackList xmlns="http://www.hikvision.com/ver20/XMLSchema">
<Track><id>101</id><Enable>false</Enable><SrcDescriptor><SrcChannel>2</SrcChannel><SrcUrl>private-source</SrcUrl><SrcLogin>private-login</SrcLogin></SrcDescriptor></Track>
<Track><id>701</id><name>原轨道名称</name><SrcDescriptor><SrcChannel>1</SrcChannel></SrcDescriptor></Track>
<Track><id>901</id><SrcDescriptor><SrcChannel>3</SrcChannel></SrcDescriptor></Track>
</TrackList>`
const names = `<InputProxyChannelList xmlns="http://www.hikvision.com/ver20/XMLSchema">
<InputProxyChannel><id>1</id><name>  测试通道甲  </name><sourceInputPortDescriptor><ipAddress>private-address</ipAddress><userName>private-user</userName></sourceInputPortDescriptor></InputProxyChannel>
<InputProxyChannel><id>2</id><name>测试通道乙 &amp; 丙</name></InputProxyChannel>
<InputProxyChannel><id>3</id><name> </name></InputProxyChannel>
<InputProxyChannel><id>99</id><name>非录像轨道</name></InputProxyChannel>
</InputProxyChannelList>`
function setup(response: string | AppError = names) {
  const request = vi.fn(async (path: string) => {
    if (path === "/ISAPI/ContentMgmt/record/tracks") return tracks
    if (response instanceof AppError) throw response
    return response
  })
  return {
    request,
    service: new NvrService(config, { request } as unknown as IsapiClient),
  }
}

describe("configured input names", () => {
  it("parses namespaces, entities, Unicode and missing/empty names without source details", () => {
    expect([...parseInputProxyNames(names)]).toEqual([
      ["1", "测试通道甲"],
      ["2", "测试通道乙 & 丙"],
      ["99", "非录像轨道"],
    ])
    expect(
      parseInputProxyNames(
        '<n:InputProxyChannelList xmlns:n="urn:test"><n:InputProxyChannel><n:id>1</n:id><n:name>甲 &lt;乙&gt;</n:name></n:InputProxyChannel></n:InputProxyChannelList>'
      ).get("1")
    ).toBe("甲 <乙>")
    expect(parseInputProxyNames("<InputProxyChannelList/>").size).toBe(0)
    expect(
      parseInputProxyNames(
        "<InputProxyChannelList><InputProxyChannel><id>1</id></InputProxyChannel></InputProxyChannelList>"
      ).size
    ).toBe(0)
    expect(parseTracks(tracks)[0].sourceChannelId).toBe("2")
  })
  it.each([
    "<broken>",
    "<ResponseStatus><statusCode>4</statusCode></ResponseStatus>",
    '<!DOCTYPE InputProxyChannelList [<!ENTITY x "private">]><InputProxyChannelList/>',
    "<InputProxyChannelList><InputProxyChannel><id>url</id><name>甲</name></InputProxyChannel></InputProxyChannelList>",
    `<InputProxyChannelList><InputProxyChannel><id>1</id><name>${"x".repeat(257)}</name></InputProxyChannel></InputProxyChannelList>`,
    "<InputProxyChannelList><InputProxyChannel><id>1</id><name>甲</name></InputProxyChannel><InputProxyChannel><id>1</id><name>乙</name></InputProxyChannel></InputProxyChannelList>",
  ])("rejects invalid/ambiguous name metadata", (xml) =>
    expect(() => parseInputProxyNames(xml)).toThrow()
  )
  it("joins explicit SrcChannel IDs, preserving track IDs, disabled tracks and fallback names", async () => {
    const { service } = setup()
    expect(await service.channels()).toEqual([
      { id: "101", name: "测试通道乙 & 丙", configuredEnabled: false },
      { id: "701", name: "测试通道甲", configuredEnabled: null },
      { id: "901", name: "轨道 901", configuredEnabled: null },
    ])
    const response = await createApp(() => service).request("/api/channels")
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).not.toMatch(
      /private-|SrcDescriptor|sourceInputPortDescriptor|sourceChannelId|ipAddress|userName/
    )
  })
  it.each([
    "NVR_FORBIDDEN",
    "NVR_TIMEOUT",
    "NVR_AUTH_FAILED",
    "NVR_UNREACHABLE",
  ])("falls back when optional names fail: %s", async (code) => {
    const { service } = setup(new AppError(code, 502, "failed"))
    expect((await service.channels()).map((channel) => channel.name)).toEqual([
      "轨道 101",
      "原轨道名称",
      "轨道 901",
    ])
  })
  it("falls back on malformed metadata; avoids guessing channel mapping when source is absent", async () => {
    expect((await setup("<invalid/>").service.channels())[0].name).toBe(
      "轨道 101"
    )
    const request = vi
      .fn()
      .mockResolvedValue(
        "<TrackList><Track><id>101</id><name>原名称</name></Track></TrackList>"
      )
    expect(
      await new NvrService(config, {
        request,
      } as unknown as IsapiClient).channels()
    ).toEqual([{ id: "101", name: "原名称", configuredEnabled: null }])
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("coalesces concurrent reads, caches names and refreshes after expiry", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000)
    const { service, request } = setup()
    try {
      const [first, second] = await Promise.all([
        service.channels(),
        service.channels(),
      ])
      expect(first).toBe(second)
      expect(request).toHaveBeenCalledTimes(2)
      await service.channels()
      expect(request).toHaveBeenCalledTimes(2)
      now.mockReturnValue(21001)
      await service.channels()
      expect(request).toHaveBeenCalledTimes(4)
    } finally {
      now.mockRestore()
    }
  })
  it("keeps mandatory track lookup failures visible and permits retry", async () => {
    const { service, request } = setup()
    request.mockRejectedValueOnce(new AppError("NVR_TIMEOUT", 504, "timeout"))
    await expect(service.channels()).rejects.toMatchObject({
      code: "NVR_TIMEOUT",
    })
    await expect(service.channels()).resolves.toHaveLength(3)
  })
})
