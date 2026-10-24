import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser"
import { z } from "zod"
import { trackIdSchema } from "../shared/contracts"
import { invalidXml } from "./errors"
import { recordingInstant, type RecordingTimeOptions } from "./time"

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
})
const object = z.record(z.string(), z.unknown())
const list = (value: unknown) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]
function root(
  xml: string,
  name: string,
  allowEmpty = false
): Record<string, unknown> {
  // No custom/external entities or document types from the device.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw invalidXml()
  try {
    const parsed = object.parse(parser.parse(xml))
    if (allowEmpty && parsed[name] === "") return {}
    return object.parse(parsed[name])
  } catch {
    throw invalidXml()
  }
}
function text(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.length) return value
  if (fallback !== undefined) return fallback
  throw invalidXml()
}
export function parseDevice(xml: string) {
  const data = root(xml, "DeviceInfo")
  return { model: text(data.model), firmware: text(data.firmwareVersion) }
}
export function parseTracks(xml: string) {
  const data = root(xml, "TrackList")
  return list(data.Track).map((item) => {
    const track = object.parse(item)
    const id = trackIdSchema.safeParse(track.id ?? track.trackID)
    if (!id.success) throw invalidXml()
    const enabled = track.Enable ?? track.enable
    if (enabled !== undefined && enabled !== "true" && enabled !== "false")
      throw invalidXml()
    const source = object.safeParse(track.SrcDescriptor)
    const sourceChannel = trackIdSchema.safeParse(
      source.success ? source.data.SrcChannel : undefined
    )
    return {
      id: id.data,
      name: text(track.name ?? track.trackName, `轨道 ${id.data}`),
      configuredEnabled: enabled === undefined ? null : enabled === "true",
      ...(sourceChannel.success ? { sourceChannelId: sourceChannel.data } : {}),
    }
  })
}
export function parseInputProxyNames(xml: string) {
  const data = root(xml, "InputProxyChannelList", true)
  const names = new Map<string, string>()
  for (const item of list(data.InputProxyChannel)) {
    const channel = object.parse(item)
    const id = trackIdSchema.parse(channel.id)
    const name = text(channel.name, "").trim()
    if (!name) continue
    if (name.length > 256 || (names.has(id) && names.get(id) !== name))
      throw invalidXml()
    names.set(id, name)
  }
  return names
}
const instant = z.iso.datetime({ offset: true })
export type RawSegment = {
  trackId: string
  startAt: string
  endAt: string
  playbackURI: string
  codec?: string
  recordType?: string
  estimatedDurationSeconds?: number
}
export function parseSearch(
  xml: string,
  time?: RecordingTimeOptions
): {
  matches: number
  more: boolean
  segments: RawSegment[]
} {
  const data = root(xml, "CMSearchResult")
  if (data.responseStatus !== "true") throw invalidXml()
  const status = text(data.responseStatusStrg).toUpperCase()
  if (!["OK", "MORE", "NO MATCHES"].includes(status)) throw invalidXml()
  const matches = Number(data.numOfMatches)
  if (!Number.isSafeInteger(matches) || matches < 0 || matches > 100000)
    throw invalidXml()
  const matchListResult = object.safeParse(data.matchList)
  if (
    data.matchList !== undefined &&
    data.matchList !== "" &&
    !matchListResult.success
  )
    throw invalidXml()
  const matchList = matchListResult.success ? matchListResult.data : {}
  const segments = list(matchList.searchMatchItem).map((item) => {
    try {
      const match = object.parse(item),
        span = object.parse(match.timeSpan),
        media = object.parse(match.mediaSegmentDescriptor)
      const startAt = recordingInstant(instant.parse(span.startTime), time),
        endAt = recordingInstant(instant.parse(span.endTime), time)
      if (Date.parse(endAt) <= Date.parse(startAt)) throw invalidXml()
      return {
        trackId: trackIdSchema.parse(match.trackID),
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
        playbackURI: text(media.playbackURI),
        ...(typeof media.codecType === "string"
          ? { codec: media.codecType }
          : {}),
        ...(typeof media.recordType === "string"
          ? { recordType: media.recordType }
          : {}),
      }
    } catch {
      throw invalidXml()
    }
  })
  if (
    matches < segments.length ||
    (matches > 0 && segments.length === 0) ||
    (status === "MORE" && !segments.length)
  )
    throw invalidXml()
  return { matches, more: status === "MORE", segments }
}
export function buildSearch(
  trackId: string,
  startAt: string,
  endAt: string,
  searchId: string,
  offset: number,
  maxResults = 40
) {
  return new XMLBuilder({ format: false }).build({
    CMSearchDescription: {
      searchID: searchId,
      trackIDList: { trackID: trackId },
      timeSpanList: { timeSpan: { startTime: startAt, endTime: endAt } },
      maxResults,
      searchResultPostion: offset,
    },
  }) as string
}
export function parseDeviceTime(xml: string) {
  const data = root(xml, "Time")
  // Only clock fields, never return the rest of the device response.
  return {
    localTime: text(data.localTime),
    timeZone: text(data.timeZone, "unknown"),
    timeMode: text(data.timeMode, "unknown"),
  }
}
export function parseDownloadCapabilities(xml: string) {
  const data = root(xml, "DownloadAbility")
  return {
    byTime: data.isSupportDownloadbyTime === "true",
    byFileName: data.isSupportDownloadbyFileName === "true",
  }
}
