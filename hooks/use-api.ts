"use client"

import { useQuery } from "@tanstack/react-query"
import {
  channelsQueryOptions,
  deviceQueryOptions,
  recordingsQueryOptions,
  type RecordingsParams,
} from "@/lib/api-queries"

export function useChannels() {
  return useQuery(channelsQueryOptions())
}

export function useDevice({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...deviceQueryOptions(), enabled })
}

export function useRecordings(params: RecordingsParams) {
  return useQuery(recordingsQueryOptions(params))
}
