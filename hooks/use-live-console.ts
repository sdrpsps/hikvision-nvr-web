"use client"

import { useCallback, useRef, useState } from "react"
import { useQueryStates } from "nuqs"
import { liveUrlParsers } from "@/lib/url-state"
import { useChannels } from "@/hooks/use-api"
import { useQueryErrorToast } from "@/hooks/use-query-error-toast"
import type { StreamPlayerHandle } from "@/components/preview-player"
import type { WallLayout } from "@/components/video-wall"

export function useLiveConsole() {
  const [urlState, setUrlState] = useQueryStates(liveUrlParsers, {
    shallow: true,
    scroll: false,
  })
  const layout = Number(urlState.layout) as WallLayout
  const selected = Math.min(urlState.window, layout) - 1
  const assignments = urlState.slots
  const sidebarOpen = urlState.sidebar
  function setSelected(index: number) {
    void setUrlState({ window: index + 1 })
  }
  function setAssignments(
    update: (old: Record<number, string>) => Record<number, string>
  ) {
    void setUrlState((old) => ({ slots: update(old.slots) }))
  }
  const channelsQuery = useChannels()
  const channels = channelsQuery.data?.channels
  const error = channelsQuery.error?.message
  useQueryErrorToast(channelsQuery, "通道读取失败")
  const [generation, setGeneration] = useState(0)
  const [activity, setActivity] = useState<Record<number, boolean>>({})
  const players = useRef(new Map<number, StreamPlayerHandle>())
  const updateActivity = useCallback((index: number, active: boolean) => {
    setActivity((old) =>
      old[index] === active ? old : { ...old, [index]: active }
    )
  }, [])
  const trackFor = (index: number) => {
    const id = assignments[index] ?? channels?.[index]?.id ?? ""
    return channels?.some((channel) => channel.id === id) ? id : ""
  }

  function setLayout(value: WallLayout) {
    void setUrlState({
      layout: String(value) as typeof urlState.layout,
      window: Math.min(selected + 1, value),
    })
  }
  function toggleSidebar() {
    void setUrlState((old) => ({ sidebar: !old.sidebar }))
  }
  function startAll() {
    for (const player of players.current.values()) player.start()
  }
  function stopAll() {
    setGeneration((value) => value + 1)
  }
  function registerPlayer(index: number, player: StreamPlayerHandle | null) {
    if (player) players.current.set(index, player)
    else players.current.delete(index)
  }

  return {
    layout,
    selected,
    sidebarOpen,
    channels,
    timeZone: channelsQuery.data?.timeZone,
    error,
    generation,
    activity,
    updateActivity,
    trackFor,
    setSelected,
    setAssignments,
    setLayout,
    toggleSidebar,
    startAll,
    stopAll,
    registerPlayer,
    refreshChannels: () => void channelsQuery.refetch(),
  }
}

export type LiveConsoleState = ReturnType<typeof useLiveConsole>
