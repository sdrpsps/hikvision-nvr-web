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

export const previewRequestSchema = recordingsQuerySchema.extend({
  segmentId: z.string().regex(/^[a-f0-9]{32}$/),
})
export const previewSchema = z.object({
  id: z.uuid(),
  playlistUrl: z.string().regex(/^\/api\/streams\/[a-f0-9-]{36}\/index\.m3u8$/),
  durationSeconds: z.number().finite().positive(),
  expiresAt: z.iso.datetime(),
  mode: z.literal("stream-copy"),
  codec: z.enum(["h264", "hevc"]),
})
export type Preview = z.infer<typeof previewSchema>
export const playbackStatusSchema = z.object({
  complete: z.boolean(),
  durationSeconds: z.number().finite().nonnegative(),
})

export const liveRequestSchema = z.strictObject({ track: trackIdSchema })
export const liveSchema = previewSchema.omit({ durationSeconds: true })
export type LiveStream = z.infer<typeof liveSchema>

export const liveAudioSchema = z.object({
  status: z.enum(["pending", "available", "unsupported"]),
  videoStartSeconds: z.number().finite(),
  chunks: z
    .array(
      z.object({
        sequence: z.number().int().nonnegative(),
        codec: z.enum(["alaw", "ulaw"]),
        sampleRate: z.union([
          z.literal(8000),
          z.literal(16000),
          z.literal(32000),
          z.literal(48000),
        ]),
        channels: z.union([z.literal(1), z.literal(2)]),
        startSeconds: z.number().finite(),
        data: z
          .string()
          .max(350000)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
    )
    .max(80),
})
