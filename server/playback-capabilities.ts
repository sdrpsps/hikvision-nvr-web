import { XMLParser, XMLValidator } from "fast-xml-parser"
import { trackIdSchema } from "../shared/contracts"
import { AppError, invalidXml } from "./errors"
import type { IsapiClient } from "./isapi"
import { parseTracks } from "./xml"

const CACHE_MS = 20000
const MAX_NATIVE_CHANNEL = 65535
const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
})

type Capabilities = {
  ipChannelBase: number
  analogChannels: number
  tracks: { id: string; sourceChannelId?: string }[]
}
type NativeTrack = { nativeChannel: number; streamIndex: 0 | 1 }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidXml()
  return value as Record<string, unknown>
}

function root(xml: string, name: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw invalidXml()
  try {
    const parsed = object(parser.parse(xml))
    const names = Object.keys(parsed).filter((key) => key !== "?xml")
    if (names.length !== 1 || names[0] !== name) throw invalidXml()
    const data = parsed[name]
    return data === "" ? {} : object(data)
  } catch {
    throw invalidXml()
  }
}

function integer(value: unknown, min: number): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,4})$/.test(value))
    throw invalidXml()
  const number = Number(value)
  if (number < min || number > MAX_NATIVE_CHANNEL) throw invalidXml()
  return number
}

export class PlaybackCapabilities {
  private cache?: { expires: number; data: Capabilities | undefined }

  constructor(private readonly client: Pick<IsapiClient, "request">) {}

  async forTrack(
    trackId: string,
    signal?: AbortSignal
  ): Promise<NativeTrack | undefined> {
    signal?.throwIfAborted()
    if (
      !trackIdSchema.safeParse(trackId).success ||
      String(Number(trackId)) !== trackId
    )
      return
    const channel = Math.floor(Number(trackId) / 100)
    const stream = Number(trackId) % 100
    if (
      channel < 1 ||
      channel > MAX_NATIVE_CHANNEL ||
      (stream !== 1 && stream !== 2)
    )
      return

    const cached =
      this.cache && this.cache.expires > Date.now() ? this.cache : undefined
    const capabilities = cached ? cached.data : await this.load(signal)
    signal?.throwIfAborted()
    let result: NativeTrack | undefined
    if (capabilities) {
      const matches = capabilities.tracks.filter(
        (track) => track.id === trackId
      )
      // Only canonical, explicitly mapped tracks have a proven native mapping.
      if (
        matches.length === 1 &&
        matches[0].sourceChannelId === String(channel)
      ) {
        const nativeChannel =
          channel <= capabilities.analogChannels
            ? channel
            : capabilities.ipChannelBase +
              channel -
              capabilities.analogChannels -
              1
        if (nativeChannel < 1 || nativeChannel > MAX_NATIVE_CHANNEL)
          throw invalidXml()
        result = { nativeChannel, streamIndex: stream === 1 ? 0 : 1 }
      }
    }
    if (!cached)
      this.cache = { expires: Date.now() + CACHE_MS, data: capabilities }
    return result
  }

  private async load(signal?: AbortSignal): Promise<Capabilities | undefined> {
    let sdkXml: string
    try {
      sdkXml = await this.client.request("/SDK/capabilities", undefined, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof AppError && error.code === "NVR_HTTP_ERROR") return
      throw error
    }
    signal?.throwIfAborted()
    const sdk = root(sdkXml, "SdkCap")
    const advertised = sdk.isSupportHttpPlayback
    if (advertised === undefined || advertised === "false") return
    if (advertised !== "true") throw invalidXml()
    const ipChannelBase = integer(sdk.ipChanBase, 1)
    const system = root(
      await this.client.request(
        "/ISAPI/System/capabilities",
        undefined,
        signal
      ),
      "DeviceCap"
    )
    signal?.throwIfAborted()
    const analogChannels = integer(
      object(object(system.SysCap).VideoCap).videoInputPortNums,
      0
    )
    const tracksXml = await this.client.request(
      "/ISAPI/ContentMgmt/record/tracks",
      undefined,
      signal
    )
    signal?.throwIfAborted()
    try {
      const trackData = root(tracksXml, "TrackList")
      return {
        ipChannelBase,
        analogChannels,
        tracks:
          trackData.Track === undefined
            ? []
            : parseTracks(tracksXml).map(({ id, sourceChannelId }) => ({
                id,
                sourceChannelId,
              })),
      }
    } catch {
      throw invalidXml()
    }
  }
}
