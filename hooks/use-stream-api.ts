"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { z } from "zod"
import { requestJson, requestEmpty } from "@/lib/api"
import {
  liveSchema,
  previewSchema,
  playbackStatusSchema,
  liveAudioSchema,
  type liveRequestSchema,
  type previewRequestSchema,
} from "@/shared/contracts"
import type { AudioLoader } from "@/lib/live-audio"

type LiveInput = z.infer<typeof liveRequestSchema> & { signal: AbortSignal }
type PlaybackInput = z.infer<typeof previewRequestSchema> & {
  signal: AbortSignal
}
const sessionMutationOptions = {
  retry: false,
  // Cleanup must also run when the browser reports that it is offline.
  networkMode: "always",
  gcTime: 0,
} as const
const prepareMessages = {
  unavailable: "预览准备失败，请重试。",
  invalid: "预览响应不完整，请重新查询。",
}

export function useCreateLiveStream() {
  return useMutation({
    ...sessionMutationOptions,
    mutationKey: ["streams", "create", "live"],
    mutationFn: ({ signal, ...input }: LiveInput) =>
      requestJson(
        "/api/streams/live",
        liveSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        },
        prepareMessages
      ),
  })
}

export function useCreatePlaybackStream() {
  return useMutation({
    ...sessionMutationOptions,
    mutationKey: ["streams", "create", "playback"],
    mutationFn: ({ signal, ...input }: PlaybackInput) =>
      requestJson(
        "/api/streams/playback",
        previewSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
        },
        prepareMessages
      ),
  })
}

export function useDeleteStream() {
  const queryClient = useQueryClient()
  return useMutation({
    ...sessionMutationOptions,
    mutationKey: ["streams", "delete"],
    mutationFn: async (id: string) => {
      try {
        await requestEmpty(`/api/streams/${id}`, {
          method: "DELETE",
          keepalive: true,
          signal: AbortSignal.timeout(8000),
        })
        return true
      } catch {
        return false
      } finally {
        queryClient.removeQueries({ queryKey: ["streams", id] })
      }
    },
  })
}

export function usePlaybackStatus(id?: string) {
  const queryClient = useQueryClient()
  const [pollingId, setPollingId] = useState<string>()
  useEffect(() => {
    if (!id) return
    const timer = setTimeout(() => setPollingId(id), 2000)
    return () => clearTimeout(timer)
  }, [id])
  const query = useQuery({
    queryKey: ["streams", id, "status"],
    enabled: !!id && pollingId === id,
    queryFn: ({ signal }) =>
      requestJson(
        `/api/streams/${id}/status`,
        playbackStatusSchema,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
        {
          unavailable: "回放连接中断，请重新播放。",
          invalid: "回放连接中断，请重新播放。",
        }
      ),
    retry: false,
    networkMode: "always",
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Status polling also renews the playback session while its tab is hidden.
    refetchIntervalInBackground: true,
    refetchInterval: (query) => (query.state.data?.complete ? 20_000 : 2000),
  })
  const confirm = useCallback(
    async (signal: AbortSignal) => {
      if (!id) throw new Error("回放连接已关闭，请重新播放。")
      // A completed cached poll cannot confirm that a session still exists.
      const queryKey = ["streams", id, "status", "confirmation"]
      try {
        return await queryClient.fetchQuery({
          queryKey,
          queryFn: ({ signal: querySignal }) =>
            requestJson(
              `/api/streams/${id}/status`,
              playbackStatusSchema,
              {
                signal: AbortSignal.any([
                  signal,
                  querySignal,
                  AbortSignal.timeout(8000),
                ]),
              },
              {
                unavailable: "无法确认录像读取状态，请重新播放。",
                invalid: "无法确认录像读取状态，请重新播放。",
              }
            ),
          retry: false,
          networkMode: "always",
          staleTime: 0,
          gcTime: 0,
        })
      } finally {
        queryClient.removeQueries({ queryKey, exact: true })
      }
    },
    [id, queryClient]
  )
  return { ...query, confirm }
}

export function useStreamAudio(id: string): AudioLoader {
  const queryClient = useQueryClient()
  const request = useRef(0)
  return useCallback(
    async ({ after, at, signal }) => {
      // Audio blocks are consumed once. A unique request key also prevents a
      // newly enabled audio player from joining a request that was just aborted.
      const queryKey = ["streams", id, "audio", after, at, ++request.current]
      try {
        return await queryClient.fetchQuery({
          queryKey,
          queryFn: ({ signal: querySignal }) => {
            const params = new URLSearchParams({ after: String(after) })
            if (at !== undefined) params.set("at", Math.max(0, at).toFixed(3))
            return requestJson(
              `/api/streams/${id}/audio?${params}`,
              liveAudioSchema,
              {
                signal: AbortSignal.any([
                  signal,
                  querySignal,
                  AbortSignal.timeout(8000),
                ]),
              }
            )
          },
          retry: false,
          networkMode: "always",
          staleTime: 0,
          gcTime: 0,
        })
      } finally {
        queryClient.removeQueries({ queryKey, exact: true })
      }
    },
    [id, queryClient]
  )
}
