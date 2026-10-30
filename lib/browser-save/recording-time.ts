import { Temporal } from "@js-temporal/polyfill"

export function recordingDayBounds(
  fileStartAt: string,
  date: string,
  timeZone = "Asia/Shanghai",
  duration?: number
) {
  const day = Temporal.PlainDate.from(date).toZonedDateTime(timeZone)
  const origin = Date.parse(fileStartAt)
  const start = Math.max(0, (day.epochMilliseconds - origin) / 1000)
  const end = Math.min(
    duration ?? Infinity,
    (day.add({ days: 1 }).epochMilliseconds - origin) / 1000
  )
  return end > start ? { start, end } : undefined
}

export function recordingTimeOfDay(value: string, date: string) {
  if (!value) return ""
  return value.slice(0, 10) > date ? "24:00:00" : value.slice(11)
}

export function recordingTime(
  fileStartAt: string,
  seconds: number,
  timeZone = "Asia/Shanghai",
  round: "floor" | "ceil" = "floor"
) {
  const milliseconds = Date.parse(fileStartAt) + seconds * 1000
  return Temporal.Instant.fromEpochMilliseconds(
    Math[round](milliseconds / 1000) * 1000
  )
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: "second" })
    .replace("T", " ")
}

export function recordingOffset(
  value: string,
  fileStartAt: string,
  timeZone = "Asia/Shanghai"
): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:[0-5]\d:[0-5]\d$/.test(value.trim()))
    return undefined
  try {
    const instant = Temporal.PlainDateTime.from(value.trim(), {
      overflow: "reject",
    })
      .toZonedDateTime(timeZone, { disambiguation: "reject" })
      .toInstant()
    const seconds = (instant.epochMilliseconds - Date.parse(fileStartAt)) / 1000
    // The first displayed whole second includes a fractional file origin.
    return Number.isFinite(seconds)
      ? seconds > -1 && seconds < 0
        ? 0
        : seconds
      : undefined
  } catch {
    return undefined
  }
}

export function recordingRange(
  source: { fileStartAt?: string; timeZone?: string },
  start: number,
  end: number
) {
  if (!source.fileStartAt) return undefined
  return `${recordingTime(source.fileStartAt, start, source.timeZone)} — ${recordingTime(source.fileStartAt, end, source.timeZone, "ceil")}`
}
