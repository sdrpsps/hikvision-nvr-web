import { randomUUID } from "node:crypto"
import { Temporal } from "@js-temporal/polyfill"
import type { Interval } from "../shared/contracts"
import type { NvrConfig } from "./config"
import { AppError } from "./errors"
import type { IsapiClient } from "./isapi"
import { validatePlaybackUri } from "./recordings"
import { buildSearch, parseSearch, type RawSegment } from "./xml"

const seconds = (milliseconds: number) => Math.round(milliseconds) / 1000

/** A diagnostic query deliberately retains out-of-window results for comparison. */
export async function queryTimeWindow(
  client: Pick<IsapiClient, "request">,
  config: NvrConfig,
  track: string,
  range: Interval,
  now = Date.now
) {
  const deadline = now() + 30_000
  const searchId = randomUUID()
  const seen = new Set<string>()
  const segments: RawSegment[] = []
  let offset = 0
  for (let page = 0; page < 100; page++) {
    if (now() >= deadline)
      throw new AppError("NVR_TIMEOUT", 504, "时间诊断搜索超过总时限。")
    const response = parseSearch(
      await client.request(
        "/ISAPI/ContentMgmt/search",
        buildSearch(
          track,
          range.startAt,
          new Date(Date.parse(range.endAt) - 1000)
            .toISOString()
            .replace(".000Z", "Z"),
          searchId,
          offset
        )
      )
    )
    let added = 0
    for (const segment of response.segments) {
      if (segment.trackId !== track)
        throw new AppError("NVR_TRACK_MISMATCH", 502, "设备返回了其他轨道。")
      validatePlaybackUri(segment.playbackURI, config)
      const key = `${segment.startAt}|${segment.endAt}|${segment.playbackURI}`
      if (seen.has(key)) continue
      seen.add(key)
      segments.push(segment)
      added++
    }
    if (!response.more)
      return segments.sort(
        (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)
      )
    if (!added)
      throw new AppError("NVR_PAGINATION_STALLED", 502, "时间诊断分页未推进。")
    offset += response.segments.length
  }
  throw new AppError("NVR_SEARCH_LIMIT", 502, "时间诊断超过分页限制。")
}

/** Keep file identifiers in memory only; the public summary contains counts. */
function fileKey(segment: RawSegment, config: NvrConfig) {
  const url = validatePlaybackUri(segment.playbackURI, config)
  const name = url.searchParams.get("name")
  return name ? `${name}\u0000${url.searchParams.get("size") ?? ""}` : undefined
}

export function summarizeTimeWindow(
  segments: RawSegment[],
  range: Interval,
  config: NvrConfig,
  reference: RawSegment[] = [],
  observedAt = Date.now()
) {
  const referenceFiles = new Set(
    reference.map((segment) => fileKey(segment, config)).filter(Boolean)
  )
  const durations = segments.map(
    (segment) => Date.parse(segment.endAt) - Date.parse(segment.startAt)
  )
  const identifiedKeys = segments
    .map((segment) => fileKey(segment, config))
    .filter((key): key is string => key !== undefined)
  const uniqueFiles = new Set(identifiedKeys)
  const matchedDurations = segments
    .filter((segment) => {
      const key = fileKey(segment, config)
      return key !== undefined && referenceFiles.has(key)
    })
    .map((segment) => Date.parse(segment.endAt) - Date.parse(segment.startAt))
  const latest = segments.length
    ? Math.max(...segments.map((segment) => Date.parse(segment.endAt)))
    : undefined
  let wallClockCandidateLeadSeconds: number | null = null
  if (latest !== undefined) {
    try {
      // A hypothesis only: interpreting the normalized UTC wall fields as local
      // time does not prove the original response's or media's time semantics.
      const candidate = Temporal.Instant.fromEpochMilliseconds(latest)
        .toZonedDateTimeISO("UTC")
        .toPlainDateTime()
        .toZonedDateTime(config.NVR_TIME_ZONE, { disambiguation: "reject" })
        .toInstant().epochMilliseconds
      wallClockCandidateLeadSeconds = seconds(candidate - observedAt)
    } catch {
      // DST ambiguity/nonexistent wall time cannot supply a candidate instant.
    }
  }
  return {
    range,
    segments: segments.length,
    identifiableFiles: uniqueFiles.size,
    duplicateFileReferences: identifiedKeys.length - uniqueFiles.size,
    matchingReferenceFiles: new Set(
      segments
        .map((segment) => fileKey(segment, config))
        .filter((key) => key && referenceFiles.has(key))
    ).size,
    matchingFilesWithChangedMetadataSpan: new Set(
      segments
        .filter((segment) =>
          reference.some(
            (prior) =>
              fileKey(segment, config) !== undefined &&
              fileKey(segment, config) === fileKey(prior, config) &&
              (segment.startAt !== prior.startAt ||
                segment.endAt !== prior.endAt)
          )
        )
        .map((segment) => fileKey(segment, config))
    ).size,
    outsideRequestedWindow: segments.filter(
      (segment) =>
        Date.parse(segment.endAt) <= Date.parse(range.startAt) ||
        Date.parse(segment.startAt) >= Date.parse(range.endAt)
    ).length,
    crossingRequestedBoundary: segments.filter(
      (segment) =>
        Date.parse(segment.startAt) < Date.parse(range.startAt) ||
        Date.parse(segment.endAt) > Date.parse(range.endAt)
    ).length,
    metadataDurationSeconds: durations.length
      ? {
          min: seconds(Math.min(...durations)),
          max: seconds(Math.max(...durations)),
          total: seconds(
            durations.reduce((sum, duration) => sum + duration, 0)
          ),
        }
      : null,
    matchingReferenceMetadataDurationSeconds: matchedDurations.length
      ? {
          min: seconds(Math.min(...matchedDurations)),
          max: seconds(Math.max(...matchedDurations)),
        }
      : null,
    touchingRequestStart: segments.filter(
      (segment) => Date.parse(segment.startAt) === Date.parse(range.startAt)
    ).length,
    touchingInclusiveRequestEnd: segments.filter(
      (segment) => Date.parse(segment.endAt) === Date.parse(range.endAt) - 1000
    ).length,
    latestEndLeadSeconds:
      latest === undefined ? null : seconds(latest - observedAt),
    wallClockCandidateLeadSeconds,
  }
}

export function middleTimeWindow(segment: RawSegment): Interval | undefined {
  const start = Date.parse(segment.startAt)
  const end = Date.parse(segment.endAt)
  if (end - start < 3000) return undefined
  const width = Math.min(30_000, Math.floor((end - start) / 2 / 1000) * 1000)
  const middle = Math.floor((start + end) / 2 / 1000) * 1000
  return {
    startAt: new Date(
      middle - Math.floor(width / 2 / 1000) * 1000
    ).toISOString(),
    endAt: new Date(middle + Math.ceil(width / 2 / 1000) * 1000).toISOString(),
  }
}

export function compareFileDuration(
  segment: RawSegment,
  durationSeconds: number
) {
  const metadataSeconds =
    (Date.parse(segment.endAt) - Date.parse(segment.startAt)) / 1000
  return {
    metadataDurationSeconds: metadataSeconds,
    suppliedMediaDurationSeconds: durationSeconds,
    differenceSeconds: seconds((durationSeconds - metadataSeconds) * 1000),
    mediaAnchorVerified: false,
  }
}
