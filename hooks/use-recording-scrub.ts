"use client"

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { toast } from "sonner"
import type { Recordings } from "@/shared/contracts"
import type { Slider } from "@/components/ui/slider"

type ScrubOptions = {
  data: Recordings
  requestedAt?: string
  playbackAt?: string
  onSelect: (id: string, at?: string) => void
}

export function useRecordingScrub({
  data,
  requestedAt,
  playbackAt,
  onSelect,
}: ScrubOptions) {
  const [scrub, setScrub] = useState<number>()
  const pointerGesture = useRef<{
    id: number
    seconds: number
    committed: boolean
    cancelled: boolean
    controller: AbortController
  } | null>(null)
  useEffect(() => () => pointerGesture.current?.controller.abort(), [])
  const start = Date.parse(data.range.startAt),
    total = Date.parse(data.range.endAt) - start
  const max = Math.max(0, total / 1000 - 1)
  const currentAt = playbackAt ?? requestedAt
  const position = currentAt ? (Date.parse(currentAt) - start) / 1000 : 0
  const value = Math.max(0, Math.min(max, scrub ?? position))
  function commitTime(seconds: number) {
    setScrub(undefined)
    const at = start + Math.max(0, Math.min(max, seconds)) * 1000
    const segment = data.segments.find(
      (segment) =>
        Date.parse(segment.startAt) <= at && at < Date.parse(segment.endAt)
    )
    if (!segment) {
      toast.info("所选时间没有录像，请选择有录像的时段。")
      return
    }
    onSelect(segment.id, new Date(at).toISOString())
  }
  function cancelScrub() {
    const gesture = pointerGesture.current
    if (gesture) {
      gesture.cancelled = true
      gesture.controller.abort()
    }
    setScrub(undefined)
  }
  function beginScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !data.segments.length) return
    const targetWindow = event.currentTarget.ownerDocument.defaultView
    if (!targetWindow) return
    pointerGesture.current?.controller.abort()
    const gesture = {
      id: event.pointerId,
      seconds: value,
      committed: false,
      cancelled: false,
      controller: new AbortController(),
    }
    pointerGesture.current = gesture
    setScrub(value)
    // Base UI commits changed values on document pointerup. The window handler
    // runs afterwards and also covers a press/release at the unchanged value.
    targetWindow.addEventListener(
      "pointerup",
      (released) => {
        if (released.pointerId !== gesture.id) return
        gesture.controller.abort()
        if (!gesture.cancelled && !gesture.committed)
          commitTime(gesture.seconds)
        if (pointerGesture.current === gesture) pointerGesture.current = null
      },
      { signal: gesture.controller.signal }
    )
    targetWindow.addEventListener(
      "pointercancel",
      (cancelled) => {
        if (cancelled.pointerId === gesture.id) cancelScrub()
      },
      { signal: gesture.controller.signal }
    )
  }

  const sliderEvents: Pick<
    ComponentProps<typeof Slider>,
    | "onPointerDownCapture"
    | "onPointerCancelCapture"
    | "onTouchCancelCapture"
    | "onValueChange"
    | "onValueCommitted"
  > = {
    onPointerDownCapture: beginScrub,
    onPointerCancelCapture: cancelScrub,
    onTouchCancelCapture: cancelScrub,
    onValueChange(next) {
      const seconds = Array.isArray(next) ? next[0] : next
      if (Number.isFinite(seconds)) {
        const gesture = pointerGesture.current
        if (gesture && !gesture.cancelled) gesture.seconds = seconds
        setScrub(seconds)
      }
    },
    onValueCommitted(next, details) {
      const seconds = Array.isArray(next) ? next[0] : next
      if (!Number.isFinite(seconds)) return
      const pointerCommit =
        details.reason === "drag" || details.reason === "track-press"
      const gesture = pointerGesture.current
      if (
        details.event.type === "pointercancel" ||
        details.event.type === "touchcancel" ||
        (pointerCommit && gesture?.cancelled)
      ) {
        setScrub(undefined)
        return
      }
      if (pointerCommit && gesture) {
        if (gesture.committed) return
        gesture.committed = true
      }
      commitTime(seconds)
    },
  }

  return { scrub, start, total, max, currentAt, value, sliderEvents }
}
