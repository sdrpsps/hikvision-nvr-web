import { queryOptions } from "@tanstack/react-query"
import {
  channelsSchema,
  deviceSchema,
  recordingsQuerySchema,
  recordingsSchema,
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
        `/api/recordings?${new URLSearchParams(query)}`,
        recordingsSchema,
        { signal }
      )
    },
    enabled: recordingsQuerySchema.safeParse(params).success,
    staleTime: 0,
  })
}
