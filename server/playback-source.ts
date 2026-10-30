import { AppError } from "./errors"
import type { RawSegment } from "./xml"

export type PlaybackRecording = RawSegment & {
  replay: { startAt: string; endAt: string; requestedAt: string }
  fileDurationSeconds: number
}

// Only a small decode lead-in is read; a distant seek never reads the file prefix.
const REPLAY_PREROLL_MS = 2000

export function replayRecording(
  segment: RawSegment,
  requestedAt = segment.startAt
): PlaybackRecording {
  const target = Date.parse(requestedAt)
  const start = Date.parse(segment.startAt)
  const end = Date.parse(segment.endAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new AppError("MEDIA_CLOCK_UNCONFIRMED", 502, "录像时间范围不完整。")
  if (!Number.isFinite(target) || target < start || target >= end)
    throw new AppError("INVALID_PLAYBACK_TIME", 400, "所选时间不在这段录像内。")
  const fileRange = segment.fileRange
  if (!fileRange)
    throw new AppError(
      "MEDIA_CLOCK_UNCONFIRMED",
      502,
      "无法确认录像文件的时间范围，请刷新后重试。"
    )
  const fileStart = Date.parse(fileRange.startAt)
  const fileEnd = Date.parse(fileRange.endAt)
  if (
    !Number.isFinite(fileStart) ||
    !Number.isFinite(fileEnd) ||
    fileEnd <= fileStart ||
    fileStart > start ||
    fileEnd < end
  )
    throw new AppError("MEDIA_CLOCK_UNCONFIRMED", 502, "录像时间范围不完整。")
  const replayStartAt = new Date(
    Math.max(fileStart, Math.floor((target - REPLAY_PREROLL_MS) / 1000) * 1000)
  ).toISOString()
  return {
    ...segment,
    // This is a requested window, never evidence of the actual first frame.
    replay: { startAt: replayStartAt, endAt: segment.endAt, requestedAt },
    fileDurationSeconds: (fileEnd - fileStart) / 1000,
  }
}
