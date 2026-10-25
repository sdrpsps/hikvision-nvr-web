import type { Channel } from "../shared/contracts"
import { renameChannelSchema, trackIdSchema } from "../shared/contracts"
import { AppError } from "./errors"
import type { IsapiClient } from "./isapi"
import {
  assertDeviceWriteSuccess,
  parseInputProxyName,
  parseInputProxyNames,
  parseTracks,
  renameInputProxyXml,
} from "./xml"

// Listing and renaming share one cache: pending reads must settle before a
// completed write invalidates names for every track mapped to that channel.
export class ChannelsService {
  private channelsCache?: { expires: number; data: Channel[] }
  private channelsPending?: Promise<Channel[]>

  constructor(private readonly client: IsapiClient) {}

  async list() {
    if (this.channelsCache && this.channelsCache.expires > Date.now())
      return this.channelsCache.data
    if (this.channelsPending) return this.channelsPending
    this.channelsPending = this.load().finally(() => {
      this.channelsPending = undefined
    })
    return this.channelsPending
  }
  private async load(): Promise<Channel[]> {
    const tracks = parseTracksSafe(
      await this.client.request("/ISAPI/ContentMgmt/record/tracks")
    )
    let names = new Map<string, string>()
    if (tracks.some((track) => track.sourceChannelId)) {
      try {
        names = parseInputProxyNames(
          await this.client.request("/ISAPI/ContentMgmt/InputProxy/channels")
        )
      } catch {
        // Names enrich the existing track list; unsupported/forbidden/timeout
        // responses must not prevent querying or playing otherwise valid tracks.
      }
    }
    const data = tracks.map(({ sourceChannelId, ...track }) => ({
      ...track,
      name: (sourceChannelId && names.get(sourceChannelId)) || track.name,
    }))
    this.channelsCache = { data, expires: Date.now() + 20000 }
    return data
  }
  private renaming = false
  async rename(trackId: string, input: { name: string }, signal?: AbortSignal) {
    trackId = trackIdSchema.parse(trackId)
    const { name } = renameChannelSchema.parse(input)
    if (this.renaming)
      throw new AppError("NVR_BUSY", 409, "正在修改通道名称，请稍后重试。")
    this.renaming = true
    try {
      const tracks = parseTracksSafe(
        await this.client.request(
          "/ISAPI/ContentMgmt/record/tracks",
          undefined,
          signal
        )
      )
      const matches = tracks.filter((track) => track.id === trackId)
      if (matches.length !== 1)
        throw new AppError("TRACK_NOT_FOUND", 404, "设备中不存在此录像轨道。")
      const source = matches[0].sourceChannelId
      if (!source)
        throw new AppError(
          "CHANNEL_MAPPING_MISSING",
          409,
          "设备未提供通道映射，无法安全修改名称。"
        )
      const path = `/ISAPI/ContentMgmt/InputProxy/channels/${source}`
      const before = await this.client.request(path, undefined, signal)
      const body = renameInputProxyXml(before, source, name)
      if (parseInputProxyName(before, source) !== name) {
        assertDeviceWriteSuccess(
          await this.client.request(path, body, signal, "PUT")
        )
      }
      // Read back from the device: HTTP 200 alone does not prove persistence.
      if (
        parseInputProxyName(
          await this.client.request(path, undefined, signal),
          source
        ) !== name
      )
        throw new AppError(
          "NVR_RENAME_UNCONFIRMED",
          502,
          "设备名称尚未确认，请刷新通道核对后再操作。"
        )
      return { id: trackId, name }
    } finally {
      // Drain pre-write reads before invalidation so they cannot republish old names.
      await this.channelsPending?.catch(() => {})
      this.channelsCache = undefined
      this.renaming = false
    }
  }
}

function parseTracksSafe(xml: string) {
  try {
    return parseTracks(xml)
  } catch {
    throw new AppError("NVR_INVALID_XML", 502, "设备轨道响应结构无效。")
  }
}
