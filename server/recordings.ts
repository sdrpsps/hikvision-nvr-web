import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { Temporal } from "@js-temporal/polyfill"
import type { NvrConfig } from "./config"
import { AppError } from "./errors"
import { IsapiClient } from "./isapi"
import { ChannelsService } from "./channels"
import { coverageAndGaps, dayRange, recordingSearchTime } from "./time"
import { buildSearch, parseDevice, parseSearch, type RawSegment } from "./xml"
import type { Recordings } from "../shared/contracts"

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
  private readonly channelService: ChannelsService
  private key = randomBytes(32)
  private cache = new Map<string, { expires: number; result: Recordings }>()
  private pending = new Map<string, Promise<Recordings>>()
  private active = 0
  constructor(
    readonly config: NvrConfig,
    client?: IsapiClient
  ) {
    this.client = client ?? new IsapiClient(config)
    this.channelService = new ChannelsService(this.client)
  }
  device() {
    return this.client.request("/ISAPI/System/deviceInfo").then(parseDevice)
  }
  channels() {
    return this.channelService.list()
  }
  renameChannel(
    trackId: string,
    input: { name: string },
    signal?: AbortSignal
  ) {
    return this.channelService.rename(trackId, input, signal)
  }
  async requireChannel(trackId: string) {
    if (!(await this.channels()).some((channel) => channel.id === trackId))
      throw new AppError("CHANNEL_NOT_FOUND", 404, "设备未返回此通道。")
    return trackId
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
