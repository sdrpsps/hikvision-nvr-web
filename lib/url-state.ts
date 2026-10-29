import { createParser, parseAsStringLiteral } from "nuqs/server"
import { dateSchema, trackIdSchema } from "../shared/contracts"

export const parseAsTrack = createParser({
  parse: (value) => (trackIdSchema.safeParse(value).success ? value : null),
  serialize: String,
})
// Keep a calendar date as a string: converting it to Date would add a timezone.
export const parseAsRecordingDate = createParser({
  parse: (value) => (dateSchema.safeParse(value).success ? value : null),
  serialize: String,
})
export const parseAsSidebar = createParser({
  parse: (value) =>
    value === "true" ? true : value === "false" ? false : null,
  serialize: String,
})
export const playbackUrlParsers = {
  track: parseAsTrack.withDefault(""),
  date: parseAsRecordingDate.withDefault(""),
  zoom: parseAsStringLiteral(["1", "2", "4"] as const).withDefault("1"),
  sidebar: parseAsSidebar.withDefault(true),
}
export const parseAsWindow = createParser({
  parse: (value) => (/^(?:[1-9]|1[0-6])$/.test(value) ? Number(value) : null),
  serialize: String,
})
// One-based window IDs; 0 means explicitly unassigned. Never store names or sources.
export const parseAsSlots = createParser<Record<number, string>>({
  parse(value) {
    if (!value || value.length > 240) return null
    const slots: Record<number, string> = {}
    const entries = value.split(",")
    if (entries.length > 16) return null
    for (const entry of entries) {
      const parts = entry.split(":")
      if (parts.length !== 2) return null
      const index = parseAsWindow.parse(parts[0])
      if (index === null || Object.hasOwn(slots, index - 1)) return null
      if (parts[1] !== "0" && !trackIdSchema.safeParse(parts[1]).success)
        return null
      slots[index - 1] = parts[1] === "0" ? "" : parts[1]
    }
    return slots
  },
  serialize: (slots) =>
    Object.entries(slots)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([index, track]) => `${Number(index) + 1}:${track || "0"}`)
      .join(","),
  eq: (a, b) =>
    JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b)),
})
export const liveUrlParsers = {
  layout: parseAsStringLiteral(["1", "2", "4", "8", "16"] as const).withDefault(
    "4"
  ),
  window: parseAsWindow.withDefault(1),
  sidebar: parseAsSidebar.withDefault(true),
  slots: parseAsSlots.withDefault({}),
}
