"use client"

import { useCallback, useState } from "react"
import { useQueryStates } from "nuqs"
import { playbackUrlParsers } from "@/lib/url-state"
import { useChannels, useRecordings } from "@/hooks/use-api"
import { useQueryErrorToast } from "@/hooks/use-query-error-toast"
import { useRecordingSelection } from "@/hooks/use-recording-selection"
import { dateSchema } from "@/shared/contracts"
import type { PlaybackPreferences } from "@/components/hls-video"

export function useRecordingConsole() {
  const channelsQuery = useChannels()
  const resources = channelsQuery.data
  const resourceError = channelsQuery.error?.message
  const [{ track: preferredTrack, date: preferredDate, zoom }, setUrlState] =
    useQueryStates(playbackUrlParsers, { shallow: true, scroll: false })
  const track = resources?.channels.some(
    (channel) => channel.id === preferredTrack
  )
    ? preferredTrack
    : (resources?.channels[0]?.id ?? "")
  const date = preferredDate || resources?.today || ""
  const recordingsQuery = useRecordings({ track, date })
  const [refresh, setRefresh] = useState(0)
  const [preferences, setPreferences] = useState<PlaybackPreferences>({
    rate: 1,
    sound: false,
  })
  const updatePreferences = useCallback(
    (value: Partial<PlaybackPreferences>) => {
      setPreferences((old) => ({ ...old, ...value }))
    },
    []
  )
  const key = `${track}|${date}|${refresh}|${recordingsQuery.dataUpdatedAt}`
  const error = recordingsQuery.error?.message
  useQueryErrorToast(
    resourceError ? channelsQuery : recordingsQuery,
    "录像查询失败"
  )
  const data =
    !error && !recordingsQuery.isFetching ? recordingsQuery.data : undefined
  const validDate = dateSchema.safeParse(date).success
  const loading =
    !!resources && !!track && validDate && recordingsQuery.isFetching

  function refreshQueries() {
    setRefresh((value) => value + 1)
    void channelsQuery.refetch()
    if (track && validDate) void recordingsQuery.refetch()
  }
  const selection = useRecordingSelection(key, data)

  function setTrack(value: string) {
    selection.resetSelection()
    void setUrlState({ track: value, date }, { history: "push" })
  }
  function setDate(value: string) {
    selection.resetSelection()
    void setUrlState({ track, date: value }, { history: "push" })
  }
  function setZoom(value: "1" | "2" | "4") {
    void setUrlState({ track, date, zoom: value })
  }

  return {
    resources,
    resourceError,
    error,
    track,
    date,
    zoom,
    selectionKey: key,
    validDate,
    loading,
    data,
    dataUpdatedAt: recordingsQuery.dataUpdatedAt,
    preferences,
    updatePreferences,
    refreshQueries,
    setTrack,
    setDate,
    setZoom,
    ...selection,
  }
}

export type RecordingConsoleState = ReturnType<typeof useRecordingConsole>
