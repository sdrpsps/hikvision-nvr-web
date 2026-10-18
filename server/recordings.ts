import { createHmac, randomBytes, randomUUID } from "node:crypto"
import type { NvrConfig } from "./config"
import { AppError } from "./errors"
import { IsapiClient } from "./isapi"
import { coverageAndGaps, dayRange } from "./time"
import {
  buildSearch,
  parseDevice,
  parseSearch,
  parseTracks,
  type RawSegment,
} from "./xml"
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
  private key = randomBytes(32)
  private channelsCache?: {
    expires: number
    data: ReturnType<typeof parseTracks>
  }
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
    const data = parseTracksSafe(
      await this.client.request("/ISAPI/ContentMgmt/record/tracks")
    )
    this.channelsCache = { data, expires: Date.now() + 20000 }
    return data
  }
  async queryRaw(trackId: string, date: string): Promise<RawSegment[]> {
    if (this.active >= 2)
      throw new AppError("NVR_BUSY", 429, "设备查询繁忙，请稍后重试。")
    this.active++
    const deadline = Date.now() + 30000
    try {
      if (!(await this.channels()).some((channel) => channel.id === trackId))
        throw new AppError("TRACK_NOT_FOUND", 404, "设备中不存在此录像轨道。")
      const range = dayRange(date, this.config.NVR_TIME_ZONE)
      // Device endTime is inclusive to seconds; API interval is [start, next midnight).
      const inclusiveEnd = new Date(Date.parse(range.endAt) - 1000)
        .toISOString()
        .replace(".000Z", "Z")
      const searchId = randomUUID(),
        seen = new Set<string>(),
        result: RawSegment[] = []
      let offset = 0
      for (let page = 0; page < 100; page++) {
        if (Date.now() >= deadline)
          throw new AppError(
            "NVR_TIMEOUT",
            504,
            "录像搜索超过总时限，请稍后重试。"
          )
        const response = parseSearch(
          await this.client.request(
            "/ISAPI/ContentMgmt/search",
            buildSearch(trackId, range.startAt, inclusiveEnd, searchId, offset)
          )
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
            result.push(segment)
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
    return segment
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
          warnings: segments.some(
            (segment) => Date.parse(segment.endAt) > Date.now() + 60000
          )
            ? ["FUTURE_RECORDING_TIME"]
            : [],
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
