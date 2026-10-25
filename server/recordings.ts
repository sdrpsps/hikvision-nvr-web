import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { Temporal } from "@js-temporal/polyfill"
import type { NvrConfig } from "./config"
import { AppError } from "./errors"
import { IsapiClient } from "./isapi"
import { coverageAndGaps, dayRange, recordingSearchTime } from "./time"
import {
  buildSearch,
  renameInputProxyXml,
  parseInputProxyName,
  assertDeviceWriteSuccess,
  parseDevice,
  parseInputProxyNames,
  parseSearch,
  parseTracks,
  type RawSegment,
} from "./xml"
import { renameChannelSchema, trackIdSchema } from "../shared/contracts"
import type { Channel, Recordings } from "../shared/contracts"

export function validatePlaybackUri(uri: string, config: NvrConfig) {
  try {
    const url = new URL(uri)
    if (
      uri.length > 8192 ||
      /[\s\r\n]/.test(uri) ||
      url.protocol !== "rtsp:" ||
      url.hostname !== config.NVR_HOST ||
      Number(url.port || 554) !== config.NVR_RTSP_PORT ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error()
    return url
  } catch {
    throw new AppError(
      "NVR_UNTRUSTED_URI",
      502,
      "设备返回的媒体地址不属于已配置的录像机。"
    )
  }
}
export class NvrService {
  readonly client: IsapiClient
  private key = randomBytes(32)
  private channelsCache?: {
    expires: number
    data: Channel[]
  }
  private channelsPending?: Promise<Channel[]>
  private cache = new Map<string, { expires: number; result: Recordings }>()
  private pending = new Map<string, Promise<Recordings>>()
  private active = 0
  constructor(
    readonly config: NvrConfig,
    client?: IsapiClient
  ) {
    this.client = client ?? new IsapiClient(config)
  }
  device() {
    return this.client.request("/ISAPI/System/deviceInfo").then(parseDevice)
  }
  async channels() {
    if (this.channelsCache && this.channelsCache.expires > Date.now())
      return this.channelsCache.data
    if (this.channelsPending) return this.channelsPending
    this.channelsPending = this.loadChannels().finally(() => {
      this.channelsPending = undefined
    })
    return this.channelsPending
  }
  private async loadChannels(): Promise<Channel[]> {
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
  async renameChannel(
    trackId: string,
    input: { name: string },
    signal?: AbortSignal
  ) {
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
  async queryRaw(
    trackId: string,
    date: string,
    signal?: AbortSignal
  ): Promise<RawSegment[]> {
    if (this.active >= 2)
      throw new AppError("NVR_BUSY", 429, "设备查询繁忙，请稍后重试。")
    this.active++
    const deadline = Date.now() + 30000
    try {
      signal?.throwIfAborted()
      if (!(await this.channels()).some((channel) => channel.id === trackId))
        throw new AppError("TRACK_NOT_FOUND", 404, "设备中不存在此录像轨道。")
      const range = dayRange(date, this.config.NVR_TIME_ZONE)
      const time = {
        timeZone: this.config.NVR_TIME_ZONE,
        mode: this.config.NVR_RECORDING_TIME_MODE,
      }
      // Device endTime is inclusive to seconds; API interval is [start, next midnight).
      const inclusiveEnd = new Date(Date.parse(range.endAt) - 1000)
        .toISOString()
        .replace(".000Z", "Z")
      const searchId = randomUUID(),
        seen = new Set<string>(),
        result: RawSegment[] = []
      let offset = 0
      for (let page = 0; page < 100; page++) {
        signal?.throwIfAborted()
        if (Date.now() >= deadline)
          throw new AppError(
            "NVR_TIMEOUT",
            504,
            "录像搜索超过总时限，请稍后重试。"
          )
        const response = parseSearch(
          await this.client.request(
            "/ISAPI/ContentMgmt/search",
            buildSearch(
              trackId,
              recordingSearchTime(range.startAt, time),
              recordingSearchTime(inclusiveEnd, time),
              searchId,
              offset
            ),
            signal
          ),
          time
        )
        let added = 0
        for (const segment of response.segments) {
          if (segment.trackId !== trackId)
            throw new AppError(
              "NVR_TRACK_MISMATCH",
              502,
              "设备搜索返回了其他轨道。"
            )
          validatePlaybackUri(segment.playbackURI, this.config)
          const key = `${segment.startAt}|${segment.endAt}|${segment.playbackURI}`
          if (seen.has(key)) continue
          seen.add(key)
          added++
          if (
            Date.parse(segment.startAt) < Date.parse(range.endAt) &&
            Date.parse(segment.endAt) > Date.parse(range.startAt)
          )
            result.push({
              ...segment,
              // Convert the search's inclusive last second back to the API's
              // exclusive day boundary; do not add a second at file junctions.
              endAt:
                Date.parse(segment.endAt) === Date.parse(inclusiveEnd)
                  ? new Date(range.endAt).toISOString()
                  : segment.endAt,
            })
        }
        if (!response.more)
          return result.sort(
            (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)
          )
        if (!added)
          throw new AppError(
            "NVR_PAGINATION_STALLED",
            502,
            "设备分页没有推进，请检查搜索响应。"
          )
        offset += response.segments.length
      }
      throw new AppError(
        "NVR_SEARCH_LIMIT",
        502,
        "设备搜索超过分页限制，未返回不完整结果。"
      )
    } finally {
      this.active--
    }
  }
  async resolveSegment(trackId: string, date: string, id: string) {
    const started = Date.now()
    const segment = (await this.queryRaw(trackId, date)).find(
      (segment) =>
        createHmac("sha256", this.key)
          .update(segment.playbackURI)
          .digest("hex")
          .slice(0, 32) === id
    )
    if (!segment)
      throw new AppError(
        "RECORDING_NOT_FOUND",
        404,
        "录像已变化，请刷新查询后重试。"
      )
    const fileRange = await this.resolveFileRange(
      segment,
      date,
      Date.now() - started < 5000
    )
    return fileRange === undefined
      ? segment
      : {
          ...segment,
          fileRange,
          estimatedDurationSeconds:
            (Date.parse(fileRange.endAt) - Date.parse(fileRange.startAt)) /
            1000,
          startOffsetSeconds: Math.max(
            0,
            (Date.parse(segment.startAt) - Date.parse(fileRange.startAt)) / 1000
          ),
        }
  }
  private async resolveFileRange(
    segment: RawSegment,
    date: string,
    allowNeighbors: boolean
  ) {
    const range = dayRange(date, this.config.NVR_TIME_ZONE)
    const start = Date.parse(segment.startAt)
    const end = Date.parse(segment.endAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return
    if (start > Date.parse(range.startAt) && end < Date.parse(range.endAt))
      return { startAt: segment.startAt, endAt: segment.endAt }
    if (!allowNeighbors) return

    // A day query may label only part of a file. Keep its coverage separate
    // from the full file labels; never replace the original download URI.
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const identity = (uri: string) => {
        const params = validatePlaybackUri(uri, this.config).searchParams
        if (
          params.getAll("name").length !== 1 ||
          params.getAll("size").length !== 1
        )
          return
        const name = params.get("name")
        const size = params.get("size")
        if (!name?.trim() || !size?.trim()) return
        return { name, size }
      }
      const file = identity(segment.playbackURI)
      if (!file) return
      const day = Temporal.PlainDate.from(date)
      const dates: string[] = []
      if (start <= Date.parse(range.startAt))
        dates.push(day.subtract({ days: 1 }).toString())
      if (end >= Date.parse(range.endAt))
        dates.push(day.add({ days: 1 }).toString())
      const controller = new AbortController()
      timeout = setTimeout(() => controller.abort(), 1500)
      const neighbors = await Promise.allSettled(
        dates.map((neighbor) =>
          this.queryRaw(segment.trackId, neighbor, controller.signal)
        )
      )
      const intervals = [{ start, end }]
      let outerStart = Date.parse(range.startAt)
      let outerEnd = Date.parse(range.endAt)
      for (const [index, result] of neighbors.entries()) {
        if (result.status === "rejected") return
        const neighborRange = dayRange(dates[index], this.config.NVR_TIME_ZONE)
        const neighborStart = Date.parse(neighborRange.startAt)
        const neighborEnd = Date.parse(neighborRange.endAt)
        outerStart = Math.min(outerStart, neighborStart)
        outerEnd = Math.max(outerEnd, neighborEnd)
        const matches = result.value.filter((candidate) => {
          if (candidate.trackId !== segment.trackId) return false
          const candidateFile = identity(candidate.playbackURI)
          return (
            candidateFile?.name === file.name &&
            candidateFile.size === file.size &&
            Date.parse(candidate.startAt) < neighborEnd &&
            Date.parse(candidate.endAt) > neighborStart
          )
        })
        if (!matches.length) return
        for (const match of matches) {
          const start = Date.parse(match.startAt)
          const end = Date.parse(match.endAt)
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
            return
          intervals.push({ start, end })
        }
      }
      intervals.sort((a, b) => a.start - b.start)
      const mergedStart = intervals[0].start
      let mergedEnd = intervals[0].end
      for (const interval of intervals.slice(1)) {
        if (interval.start > mergedEnd) return
        mergedEnd = Math.max(mergedEnd, interval.end)
      }
      if (mergedStart > outerStart && mergedEnd < outerEnd)
        return {
          startAt: new Date(mergedStart).toISOString(),
          endAt: new Date(mergedEnd).toISOString(),
        }
    } catch {
      // Optional metadata must never block an otherwise valid file download.
    } finally {
      clearTimeout(timeout)
    }
  }
  async recordings(trackId: string, date: string): Promise<Recordings> {
    const key = `${trackId}|${date}`,
      cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.result
    if (this.pending.has(key)) return this.pending.get(key)!
    const query = this.queryRaw(trackId, date)
      .then((raw) => {
        const range = dayRange(date, this.config.NVR_TIME_ZONE)
        const segments = raw.map((segment) => ({
          startAt: segment.startAt,
          endAt: segment.endAt,
          codec: segment.codec,
          recordType: segment.recordType,
          id: createHmac("sha256", this.key)
            .update(segment.playbackURI)
            .digest("hex")
            .slice(0, 32),
        }))
        const result: Recordings = {
          trackId,
          date,
          timeZone: this.config.NVR_TIME_ZONE,
          range,
          segments,
          ...coverageAndGaps(segments, range),
          warnings: [],
        }
        for (const [key, item] of this.cache)
          if (item.expires <= Date.now()) this.cache.delete(key)
        if (this.cache.size >= 32)
          this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(key, { result, expires: Date.now() + 30000 })
        return result
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, query)
    return query
  }
}
function parseTracksSafe(xml: string) {
  try {
    return parseTracks(xml)
  } catch {
    throw new AppError("NVR_INVALID_XML", 502, "设备轨道响应结构无效。")
  }
}
