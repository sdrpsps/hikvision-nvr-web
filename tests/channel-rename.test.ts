import { describe, expect, it, vi } from "vitest"
import { XMLParser } from "fast-xml-parser"
import { renameInputProxyXml, assertDeviceWriteSuccess } from "../server/xml"
import { renameChannelSchema } from "../shared/contracts"
import { NvrService } from "../server/recordings"
import { IsapiClient } from "../server/isapi"
import { readNvrConfig } from "../server/config"
import { AppError } from "../server/errors"
import { createApp } from "../server/app"

const config = readNvrConfig({
  NVR_HOST: "nvr.test",
  NVR_USERNAME: "test",
  NVR_PASSWORD: "secret",
})
const tracks =
  "<TrackList><Track><id>701</id><SrcDescriptor><SrcChannel>2</SrcChannel></SrcDescriptor></Track><Track><id>702</id><SrcDescriptor><SrcChannel>2</SrcChannel></SrcDescriptor></Track></TrackList>"
const xml =
  '<h:InputProxyChannel xmlns:h="urn:test" version="2.0"><h:id>2</h:id><h:name>原名称</h:name><h:sourceInputPortDescriptor><h:ipAddress>private-address</h:ipAddress><h:password>private-secret&amp;x</h:password></h:sourceInputPortDescriptor><h:enabled>false</h:enabled><h:other flag="1"/></h:InputProxyChannel>'
const ok =
  "<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>"
function setup() {
  let current = xml
  const request = vi.fn(async (path: string, body?: string) => {
    if (path.endsWith("/tracks")) return tracks
    if (path.endsWith("/channels"))
      return `<InputProxyChannelList>${current}</InputProxyChannelList>`
    if (body) {
      current = body
      return ok
    }
    return current
  })
  return {
    request,
    service: new NvrService(config, { request } as unknown as IsapiClient),
  }
}
describe("channel rename", () => {
  it("changes only the name, preserving namespace, attributes, credentials and unknown fields", () => {
    const result = renameInputProxyXml(xml, "2", "门口 & <院子>")
    const parser = new XMLParser({ ignoreAttributes: false })
    const before = parser.parse(xml)
    before["h:InputProxyChannel"]["h:name"] = "门口 & <院子>"
    expect(parser.parse(result)).toEqual(before)
    expect(result).toContain("&amp;")
    expect(() => renameInputProxyXml(xml, "1", "x")).toThrow()
    expect(() =>
      renameInputProxyXml(xml.replace("<h:name>原名称</h:name>", ""), "2", "x")
    ).toThrow()
    expect(() => renameInputProxyXml("<!DOCTYPE x>" + xml, "2", "x")).toThrow()
  })
  it.each([
    "",
    " ",
    "中".repeat(11),
    "x".repeat(33),
    "a\n",
    "\u0000",
    "\ud800",
    "\uffff",
  ])("rejects invalid names: %j", (name) => {
    // Outer whitespace is intentionally trimmed.
    if (name === "a\n")
      return expect(renameChannelSchema.parse({ name }).name).toBe("a")
    expect(renameChannelSchema.safeParse({ name }).success).toBe(false)
  })
  it("uses explicit source mapping, verifies persistence, invalidates all track aliases, hides private configuration", async () => {
    const { service, request } = setup()
    await service.channels()
    const response = await createApp(() => service).request(
      "/api/channels/701/name",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "门口 & 院子" }),
      }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "701", name: "门口 & 院子" })
    expect(request.mock.calls.filter(([, body]) => body)).toHaveLength(1)
    expect(request).toHaveBeenCalledWith(
      "/ISAPI/ContentMgmt/InputProxy/channels/2",
      expect.any(String),
      expect.any(AbortSignal),
      "PUT"
    )
    expect((await service.channels()).map((c) => c.name)).toEqual([
      "门口 & 院子",
      "门口 & 院子",
    ])
  })
  it.each([
    "NVR_FORBIDDEN",
    "NVR_AUTH_FAILED",
    "NVR_TIMEOUT",
    "NVR_UNREACHABLE",
  ])("keeps failed writes visible without success: %s", async (code) => {
    const { service, request } = setup()
    request.mockImplementation(async (_path, body) => {
      if (body) throw new AppError(code, 502, "设备操作失败")
      return _path.endsWith("/tracks") ? tracks : xml
    })
    await expect(
      service.renameChannel("701", { name: "新名称" })
    ).rejects.toMatchObject({ code })
  })
  it("rejects device error status even with HTTP 200 and detects unchanged readback", async () => {
    expect(() =>
      assertDeviceWriteSuccess(
        "<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString></ResponseStatus>"
      )
    ).toThrow()
    const { service, request } = setup()
    // A successful PUT status followed by the old name must fail.
    request.mockImplementation(async (path, body) =>
      body ? ok : path.endsWith("/tracks") ? tracks : xml
    )
    await expect(
      service.renameChannel("701", { name: "新名称" })
    ).rejects.toMatchObject({ code: "NVR_RENAME_UNCONFIRMED" })
  })
  it("rejects missing tracks and absent mapping without writing", async () => {
    const { service, request } = setup()
    await expect(
      service.renameChannel("999", { name: "x" })
    ).rejects.toMatchObject({ code: "TRACK_NOT_FOUND" })
    request.mockResolvedValue(
      "<TrackList><Track><id>701</id></Track></TrackList>"
    )
    await expect(
      service.renameChannel("701", { name: "x" })
    ).rejects.toMatchObject({ code: "CHANNEL_MAPPING_MISSING" })
    expect(request.mock.calls.every(([, body]) => !body)).toBe(true)
  })
  it("serializes device writes", async () => {
    const { service } = setup()
    const first = service.renameChannel("701", { name: "新名称" })
    await expect(
      service.renameChannel("701", { name: "另一个" })
    ).rejects.toMatchObject({ code: "NVR_BUSY" })
    await first
  })
  it("rejects cross-origin, extra properties, bad JSON and oversized bodies before accessing the NVR", async () => {
    const { service, request } = setup(),
      app = createApp(() => service)
    for (const init of [
      {
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.test",
        },
        body: '{"name":"x"}',
      },
      {
        headers: { "Content-Type": "application/json" },
        body: '{"name":"x","host":"evil"}',
      },
      { headers: { "Content-Type": "application/json" }, body: "{" },
      { headers: { "Content-Type": "text/plain" }, body: '{"name":"x"}' },
      {
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(1025),
      },
    ] as RequestInit[])
      expect(
        (
          await app.request("/api/channels/701/name", {
            method: "PUT",
            ...init,
          })
        ).status
      ).toBeGreaterThanOrEqual(400)
    expect(request).not.toHaveBeenCalled()
  })
  it("authenticates PUT with Digest, preserves method/body and blocks unrelated writes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Digest realm="test", nonce="abc", qop="auth"',
          },
        })
      )
      .mockResolvedValueOnce(new Response(ok))
    const client = new IsapiClient(config, fetcher)
    await client.request(
      "/ISAPI/ContentMgmt/InputProxy/channels/2",
      xml,
      undefined,
      "PUT"
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      body: xml,
      headers: { Authorization: expect.stringContaining("Digest ") },
    })
    await expect(
      client.request("/ISAPI/System/deviceInfo", xml, undefined, "PUT")
    ).rejects.toMatchObject({ code: "INVALID_DEVICE_PATH" })
    await expect(
      client.request(
        "/ISAPI/ContentMgmt/InputProxy/channels/2?host=evil",
        xml,
        undefined,
        "PUT"
      )
    ).rejects.toMatchObject({ code: "INVALID_DEVICE_PATH" })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
