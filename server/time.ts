import { Temporal } from "@js-temporal/polyfill"
import type { Interval } from "../shared/contracts"

export type RecordingTimeOptions = {
  timeZone: string
  mode: "device-local" | "utc"
}

/** Serialize an instant for the NVR's recording search, never for the API. */
export function recordingSearchTime(
  iso: string,
  options: RecordingTimeOptions
) {
  const instant = Temporal.Instant.from(iso)
  if (options.mode === "utc") return instant.toString()
  return `${instant.toZonedDateTimeISO(options.timeZone).toPlainDateTime().toString({ smallestUnit: "second" })}Z`
}

/** Only the legacy Z convention needs reinterpretation; explicit offsets win. */
export function recordingInstant(iso: string, options?: RecordingTimeOptions) {
  if (options?.mode === "device-local" && iso.endsWith("Z"))
    return Temporal.PlainDateTime.from(iso.slice(0, -1))
      .toZonedDateTime(options.timeZone, { disambiguation: "reject" })
      .toInstant()
      .toString({ smallestUnit: "millisecond" })
  return Temporal.Instant.from(iso).toString({ smallestUnit: "millisecond" })
}

export function dayRange(date: string, timeZone: string): Interval {
  const day = Temporal.PlainDate.from(date)
  const start = day.toZonedDateTime(timeZone)
  const end = day.add({ days: 1 }).toZonedDateTime(timeZone)
  return {
    startAt: start.toInstant().toString(),
    endAt: end.toInstant().toString(),
  }
}
export function todayIn(timeZone: string) {
  return Temporal.Now.plainDateISO(timeZone).toString()
}
export function coverageAndGaps(intervals: Interval[], range: Interval) {
  const start = Date.parse(range.startAt),
    end = Date.parse(range.endAt)
  const coverage: Interval[] = []
  for (const item of [...intervals].sort(
    (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)
  )) {
    const a = Math.max(start, Date.parse(item.startAt)),
      b = Math.min(end, Date.parse(item.endAt))
    if (a >= b) continue
    const last = coverage.at(-1)
    if (last && a <= Date.parse(last.endAt))
      last.endAt = new Date(Math.max(b, Date.parse(last.endAt))).toISOString()
    else
      coverage.push({
        startAt: new Date(a).toISOString(),
        endAt: new Date(b).toISOString(),
      })
  }
  const gaps: Interval[] = []
  let cursor = start
  for (const item of coverage) {
    if (Date.parse(item.startAt) > cursor)
      gaps.push({
        startAt: new Date(cursor).toISOString(),
        endAt: item.startAt,
      })
    cursor = Date.parse(item.endAt)
  }
  if (cursor < end)
    gaps.push({
      startAt: new Date(cursor).toISOString(),
      endAt: new Date(end).toISOString(),
    })
  return { coverage, gaps }
}
