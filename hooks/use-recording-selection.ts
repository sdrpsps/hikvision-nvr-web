"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"
import type { Recordings } from "@/shared/contracts"
import { duration } from "@/components/recording/format"

type RecordingSelection = {
  key: string
  selected: string
  requestedTime?: { at: string; revision: number }
  playbackAt?: string
  active?: boolean
  automatic: string
  listOpen: boolean
}

function emptySelection(key: string): RecordingSelection {
  return {
    key,
    selected: "",
    automatic: "",
    listOpen: false,
  }
}

export function useRecordingSelection(key: string, data?: Recordings) {
  const [selection, setSelection] = useState(() => emptySelection(""))
  const activeSelection =
    selection.key === key ? selection : emptySelection(key)
  const { selected, requestedTime, listOpen } = activeSelection
  const updatePlaybackTime = useCallback(
    (at: string | undefined) => {
      setSelection((old) =>
        old.key === key && old.selected === selected && old.playbackAt !== at
          ? { ...old, playbackAt: at }
          : old
      )
    },
    [key, selected, setSelection]
  )
  const updatePlaybackActivity = useCallback(
    (active: boolean) => {
      setSelection((old) =>
        old.key === key && old.selected === selected && old.active !== active
          ? { ...old, active }
          : old
      )
    },
    [key, selected, setSelection]
  )
  function updateSelection(patch: Partial<Omit<RecordingSelection, "key">>) {
    setSelection((old) => ({
      ...(old.key === key ? old : emptySelection(key)),
      ...patch,
    }))
  }
  const segment = data?.segments.find((segment) => segment.id === selected)
  function selectSegment(id: string, at?: string) {
    const item = data?.segments.find((candidate) => candidate.id === id)
    if (!item) return
    setSelection((old) => {
      const current = old.key === key ? old : emptySelection(key)
      return {
        ...current,
        selected: id,
        automatic: "",
        requestedTime: {
          at: at ?? item.startAt,
          revision: (current.requestedTime?.revision ?? 0) + 1,
        },
        playbackAt: undefined,
      }
    })
  }
  function stopSequence() {
    updateSelection({ automatic: "" })
  }
  function nextSegment() {
    if (!data || !segment) return
    const next =
      data.segments[
        data.segments.findIndex((item) => item.id === segment.id) + 1
      ]
    if (!next) {
      updateSelection({
        automatic: "",
      })
      toast.info("已播放到当日最后一个片段。")
      return
    }
    const gap = Date.parse(next.startAt) - Date.parse(segment.endAt)
    if (gap > 1000)
      toast.warning(
        `已切换到下一片段；搜索结果中间有 ${duration(gap)}未覆盖区间。`
      )
    updateSelection({
      automatic: next.id,
      selected: next.id,
      requestedTime: {
        at: next.startAt,
        revision: (requestedTime?.revision ?? 0) + 1,
      },
      playbackAt: undefined,
    })
  }

  return {
    selected,
    requestedTime,
    playbackAt: activeSelection.playbackAt,
    active: activeSelection.active,
    automatic: activeSelection.automatic,
    listOpen,
    segment,
    selectSegment,
    updatePlaybackTime,
    updatePlaybackActivity,
    nextSegment,
    stopSequence,
    resetSelection: () => setSelection(emptySelection("")),
    toggleList: () => updateSelection({ listOpen: !listOpen }),
  }
}
