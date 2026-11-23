import { queryOptions, type QueryClient } from "@tanstack/react-query"
import {
  channelsSchema,
  deviceSchema,
  recordingsQuerySchema,
  recordingsSchema,
  type Recordings,
} from "../shared/contracts"
import { requestJson } from "./api"

export type RecordingsParams = { track: string; date: string }

export const apiKeys = {
  channels: ["channels"] as const,
  device: ["device"] as const,
  recordings: ({ track, date }: RecordingsParams) =>
    ["recordings", track, date] as const,
}

export function channelsQueryOptions() {
  return queryOptions({
    queryKey: apiKeys.channels,
    queryFn: ({ signal }) =>
      requestJson("/api/channels", channelsSchema, { signal }),
    staleTime: 30_000,
  })
}

export function deviceQueryOptions() {
  return queryOptions({
    queryKey: apiKeys.device,
    queryFn: async ({ signal }) => {
      try {
        return await requestJson("/api/device", deviceSchema, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError")
          throw new Error("设备信息读取超时，请重试。")
        throw error
      }
    },
    staleTime: Infinity,
  })
}

export function recordingsQueryOptions(params: RecordingsParams) {
  return queryOptions({
    queryKey: apiKeys.recordings(params),
    queryFn: ({ signal }) => {
      const query = recordingsQuerySchema.parse(params)
      return requestJson(
        `/api/recordings?${new URLSearchParams({ track: query.track, date: query.date })}`,
        recordingsSchema,
        { signal }
      )
    },
    enabled: recordingsQuerySchema.safeParse(params).success,
    staleTime: 0,
  })
}

export function fetchFreshRecordings(
  params: RecordingsParams,
  signal?: AbortSignal
) {
  const query = recordingsQuerySchema.parse(params)
  return requestJson(
    `/api/recordings?${new URLSearchParams({
      track: query.track,
      date: query.date,
      fresh: "1",
    })}`,
    recordingsSchema,
    { signal }
  )
}

export function extendRecordingCache(
  queryClient: QueryClient,
  params: RecordingsParams,
  segmentId: string,
  fileRange: { startAt: string; endAt: string }
) {
  queryClient.setQueryData<Recordings>(apiKeys.recordings(params), (old) => {
    if (!old) return old
    const index = old.segments.findIndex((item) => item.id === segmentId)
    if (index < 0) return old
    if (Date.parse(fileRange.startAt) > Date.parse(old.segments[index].endAt))
      return old
    const clampedEnd = Math.min(
      Date.parse(fileRange.endAt),
      Date.parse(old.range.endAt)
    )
    if (
      !Number.isFinite(clampedEnd) ||
      clampedEnd <= Date.parse(old.segments[index].endAt)
    )
      return old
    const nextEnd = new Date(clampedEnd).toISOString()
    const segments = old.segments.map((item, i) =>
      i === index ? { ...item, endAt: nextEnd } : item
    )
    const coverage = old.coverage.map((item, i) =>
      i === old.coverage.length - 1 &&
      Date.parse(item.endAt) < clampedEnd &&
      Date.parse(item.endAt) >= Date.parse(old.segments[index].startAt)
        ? { ...item, endAt: nextEnd }
        : item
    )
    return { ...old, segments, coverage }
  })
}
