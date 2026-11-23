export type PlaybackTimeRequest = { at: string; revision: number }

export function playbackOffset(at: string, startAt: string) {
  return (Date.parse(at) - Date.parse(startAt)) / 1000
}

export function playbackInstant(startAt: string, seconds: number) {
  return new Date(Date.parse(startAt) + seconds * 1000).toISOString()
}

export function formatMediaClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const clock = `${String(minutes % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
  return minutes >= 60
    ? `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${clock}`
    : clock
}

export function resolveSeekEnd(
  seekable: TimeRanges,
  totalDuration: number | undefined,
  duration: number,
  complete?: boolean
) {
  let seekableEnd: number | undefined
  for (let index = 0; index < seekable.length; index++) {
    const rangeEnd = seekable.end(index)
    if (seekableEnd === undefined || rangeEnd > seekableEnd)
      seekableEnd = rangeEnd
  }
  const end = totalDuration ?? duration
  if (
    complete &&
    seekableEnd !== undefined &&
    (!Number.isFinite(end) || (end > seekableEnd && end - seekableEnd <= 1))
  )
    return seekableEnd
  return end
}

export function snapToSeekable(
  seekable: TimeRanges,
  target: number,
  complete?: boolean
) {
  for (let index = 0; index < seekable.length; index++) {
    const start = seekable.start(index)
    const end = seekable.end(index)
    if (target >= start && target <= end) return target
    if (target < start && start - target <= 0.15) return start
    if (complete && target > end && target - end <= 0.15)
      return Math.max(start, end - 0.001)
  }
  return undefined
}

export function isTargetSeekable(element: HTMLVideoElement, target: number) {
  if (
    Number.isNaN(element.duration) ||
    (Number.isFinite(element.duration) && target > element.duration)
  )
    return false
  for (let index = 0; index < element.seekable.length; index++) {
    if (
      target >= element.seekable.start(index) &&
      target <= element.seekable.end(index)
    )
      return true
  }
  return false
}
