import { useState } from "react"
import {
  recordingOffset,
  recordingTime,
  recordingDayBounds,
} from "@/lib/browser-save/recording-time"

export function useClipSelection(
  fileStartAt: string | undefined,
  timeZone: string | undefined,
  duration: number | undefined,
  date: string
) {
  const bounds = fileStartAt
    ? recordingDayBounds(fileStartAt, date, timeZone, duration)
    : undefined
  const clock = (seconds: number, round: "floor" | "ceil" = "floor") =>
    fileStartAt ? recordingTime(fileStartAt, seconds, timeZone, round) : ""
  const [from, setFrom] = useState(() => (bounds ? clock(bounds.start) : ""))
  const [to, setTo] = useState(() =>
    bounds ? clock(Math.min(bounds.start + 30, bounds.end), "ceil") : ""
  )
  const [error, setError] = useState("")
  const a = fileStartAt
    ? recordingOffset(from, fileStartAt, timeZone)
    : undefined
  const b = fileStartAt ? recordingOffset(to, fileStartAt, timeZone) : undefined
  const valid = a !== undefined && b !== undefined && b > a
  const min = bounds?.start ?? 0
  const max =
    duration === undefined || !bounds ? undefined : Math.ceil(bounds.end)
  const first = bounds ? clock(bounds.start) : ""
  const last = bounds ? clock(bounds.end, "ceil") : ""
  const clamp = (seconds: number) =>
    bounds ? Math.max(bounds.start, Math.min(seconds, bounds.end)) : 0
  function change(which: "start" | "end", value: string) {
    if (which === "start") setFrom(value)
    else setTo(value)
    setError("")
  }
  function mark(which: "start" | "end", position: number) {
    change(which, clock(clamp(position), which === "start" ? "floor" : "ceil"))
  }
  function selection() {
    if (!fileStartAt || !bounds) {
      setError("尚未确认当天可下载的录像范围。")
    } else if (!valid) {
      setError("请选择有效的录像时间，终点必须晚于起点。")
    } else if (
      a < bounds.start ||
      a >= bounds.end ||
      b > (recordingOffset(last, fileStartAt, timeZone) ?? bounds.end)
    ) {
      setError("起止时间超出当天可下载范围，请重新选择。")
    } else if (b - a > 86400) {
      setError("单次下载最长不超过 24 小时。")
    } else {
      setError("")
      return {
        startSeconds: a,
        endSeconds: Math.min(b, bounds.end),
      }
    }
  }
  return {
    from,
    to,
    a,
    b,
    valid,
    min,
    max,
    first,
    last,
    error,
    clock,
    clamp,
    change,
    mark,
    selection,
  }
}
