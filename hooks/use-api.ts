"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  apiKeys,
  channelsQueryOptions,
  deviceQueryOptions,
  recordingsQueryOptions,
  type RecordingsParams,
} from "@/lib/api-queries"

import { requestJson } from "@/lib/api"
import {
  channelSchema,
  renameChannelSchema,
  trackIdSchema,
} from "@/shared/contracts"

export function useChannels() {
  return useQuery(channelsQueryOptions())
}

export function useDevice({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...deviceQueryOptions(), enabled })
}

export function useRecordings(params: RecordingsParams) {
  return useQuery(recordingsQueryOptions(params))
}

export function useRenameChannel() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const input = renameChannelSchema.parse({ name })
      return requestJson(
        `/api/channels/${trackIdSchema.parse(id)}/name`,
        channelSchema.pick({ id: true, name: true }),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(45_000),
        }
      )
    },
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: apiKeys.channels })
      await client.invalidateQueries({ queryKey: apiKeys.channels })
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: apiKeys.channels })
    },
  })
}
