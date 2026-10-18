import { Temporal } from "@js-temporal/polyfill"
import type { Interval } from "../shared/contracts"

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
