import { z } from "zod"

export const trackIdSchema = z.string().regex(/^[1-9]\d{0,8}$/)
export const dateSchema = z.iso.date()
export const recordingsQuerySchema = z.strictObject({
  track: trackIdSchema,
  date: dateSchema,
})
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})
export const deviceSchema = z.object({
  model: z.string(),
  firmware: z.string(),
})
export const channelSchema = z.object({
  id: trackIdSchema,
  name: z.string(),
  configuredEnabled: z.boolean().nullable(),
})
export const channelsSchema = z.object({
  timeZone: z.string(),
  today: dateSchema,
  channels: z.array(channelSchema),
})
const intervalSchema = z.object({
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
})
export const recordingsSchema = z.object({
  trackId: trackIdSchema,
  date: dateSchema,
  timeZone: z.string(),
  range: intervalSchema,
  segments: z.array(
    intervalSchema.extend({
      id: z.string(),
      codec: z.string().optional(),
      recordType: z.string().optional(),
    })
  ),
  coverage: z.array(intervalSchema),
  gaps: z.array(intervalSchema),
  warnings: z.array(z.enum(["FUTURE_RECORDING_TIME"])),
})
export type Channel = z.infer<typeof channelSchema>
export type Recordings = z.infer<typeof recordingsSchema>
export type Interval = z.infer<typeof intervalSchema>
