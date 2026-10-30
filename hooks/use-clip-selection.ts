import { useState } from "react"
import {
  recordingOffset,
  recordingTime,
} from "@/lib/browser-save/recording-time"

export function useClipSelection(
  fileStartAt: string | undefined,
  timeZone: string | undefined,
  duration: number | undefined
) {
  const clock = (seconds: number, round: "floor" | "ceil" = "floor") =>
    fileStartAt ? recordingTime(fileStartAt, seconds, timeZone, round) : ""
  const [from, setFrom] = useState(() => clock(0))
  const [to, setTo] = useState(() =>
    clock(Math.min(30, duration ?? 30), "ceil")
  )
  const [error, setError] = useState("")
  const a = fileStartAt
    ? recordingOffset(from, fileStartAt, timeZone)
    : undefined
  const b = fileStartAt ? recordingOffset(to, fileStartAt, timeZone) : undefined
  const valid = a !== undefined && b !== undefined && b > a
  const max = duration === undefined ? undefined : Math.ceil(duration)
  function change(which: "start" | "end", value: string) {
    if (which === "start") setFrom(value)
    else setTo(value)
    setError("")
  }
  function mark(which: "start" | "end", position: number) {
    change(
      which,
      clock(
        Math.max(0, Math.min(position, duration ?? position)),
        which === "start" ? "floor" : "ceil"
      )
    )
  }
  function selection() {
    if (!fileStartAt) {
      setError("尚未确认录像文件的起始时间，无法按录像时间下载。")
    } else if (!valid) {
      setError(
        "请输入有效的录像日期和时间，终点必须晚于起点。格式：年-月-日 时:分:秒。"
      )
    } else if (
      a < 0 ||
      (duration !== undefined &&
        (a >= duration ||
          b >
            (recordingOffset(clock(duration, "ceil"), fileStartAt, timeZone) ??
              duration)))
    ) {
      setError("起止时间超出当前录像文件范围，请在可下载范围内选择。")
    } else if (b - a > 86400) {
      setError("单次下载最长不超过 24 小时。")
    } else {
      setError("")
      return {
        startSeconds: a,
        endSeconds: duration === undefined ? b : Math.min(b, duration),
      }
    }
  }
  return { from, to, a, b, valid, max, error, clock, change, mark, selection }
}
