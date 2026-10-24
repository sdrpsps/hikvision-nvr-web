import { config } from "dotenv"
import { Temporal } from "@js-temporal/polyfill"
import { z } from "zod"
import { recordingsQuerySchema } from "../shared/contracts"
import { readNvrConfig } from "../server/config"
import { AppError } from "../server/errors"
import { NvrService } from "../server/recordings"
import { dayRange } from "../server/time"
import {
  compareFileDuration,
  middleTimeWindow,
  queryTimeWindow,
  summarizeTimeWindow,
} from "../server/time-diagnostics"
import { parseDeviceTime } from "../server/xml"

config({ quiet: true })
const usage =
  "用法：pnpm exec tsx scripts/verify-time.ts <track> <YYYY-MM-DD> [--media-duration=<seconds>]"

try {
  const query = recordingsQuerySchema.safeParse({
    track: process.argv[2],
    date: process.argv[3],
  })
  const options = process.argv.slice(4)
  const suppliedDuration = options[0]?.startsWith("--media-duration=")
    ? z.coerce
        .number()
        .finite()
        .positive()
        .max(7 * 86400)
        .safeParse(options[0].slice(17))
    : undefined
  if (
    !query.success ||
    options.length > 1 ||
    (options.length && !suppliedDuration?.success)
  )
    throw new AppError("INVALID_ARGUMENTS", 400, usage)
  const service = new NvrService(readNvrConfig())
  if (
    !(await service.channels()).some(
      (channel) => channel.id === query.data.track
    )
  )
    throw new AppError("TRACK_NOT_FOUND", 404, "设备中不存在此录像轨道。")

  const clock = async () => {
    const before = Date.now()
    try {
      const fields = parseDeviceTime(
        await service.client.request("/ISAPI/System/time")
      )
      const after = Date.now()
      const instant = Temporal.Instant.from(fields.localTime)
      return {
        available: true,
        deviceInstant: instant.toString(),
        observedAt: new Date(Math.round((before + after) / 2)).toISOString(),
        roundTripMs: after - before,
        offsetFromHostSeconds:
          Math.round(instant.epochMilliseconds - (before + after) / 2) / 1000,
      }
    } catch (error) {
      return {
        available: false,
        code: error instanceof AppError ? error.code : "INVALID_DEVICE_TIME",
      }
    }
  }
  const clockBefore = await clock()
  const baselineRange = dayRange(query.data.date, service.config.NVR_TIME_ZONE)
  const baseline = await queryTimeWindow(
    service.client,
    service.config,
    query.data.track,
    baselineRange
  )
  const localLabelRange = {
    startAt: `${query.data.date}T00:00:00Z`,
    endAt: `${Temporal.PlainDate.from(query.data.date).add({ days: 1 })}T00:00:00Z`,
  }
  const localLabel =
    Date.parse(localLabelRange.startAt) === Date.parse(baselineRange.startAt)
      ? baseline
      : await queryTimeWindow(
          service.client,
          service.config,
          query.data.track,
          localLabelRange
        )
  const selected = [...baseline].sort(
    (a, b) =>
      Date.parse(a.endAt) -
      Date.parse(a.startAt) -
      (Date.parse(b.endAt) - Date.parse(b.startAt))
  )[0]
  const narrowRange = selected && middleTimeWindow(selected)
  const narrow = narrowRange
    ? await queryTimeWindow(
        service.client,
        service.config,
        query.data.track,
        narrowRange
      )
    : undefined
  const expandedRange = {
    startAt: dayRange(
      Temporal.PlainDate.from(query.data.date).subtract({ days: 1 }).toString(),
      service.config.NVR_TIME_ZONE
    ).startAt,
    endAt: dayRange(
      Temporal.PlainDate.from(query.data.date).add({ days: 1 }).toString(),
      service.config.NVR_TIME_ZONE
    ).endAt,
  }
  const expanded = await queryTimeWindow(
    service.client,
    service.config,
    query.data.track,
    expandedRange
  )
  const clockAfter = await clock()
  const observedAt = Date.now()
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date(observedAt).toISOString(),
        track: query.data.track,
        date: query.data.date,
        configuredTimeZone: service.config.NVR_TIME_ZONE,
        clockBefore,
        clockAfter,
        baseline: summarizeTimeWindow(
          baseline,
          baselineRange,
          service.config,
          [],
          observedAt
        ),
        localLabelComparison: summarizeTimeWindow(
          localLabel,
          localLabelRange,
          service.config,
          baseline,
          observedAt
        ),
        narrowWindow:
          narrow && narrowRange
            ? summarizeTimeWindow(
                narrow,
                narrowRange,
                service.config,
                selected ? [selected] : [],
                observedAt
              )
            : null,
        expandedBoundaryComparison: summarizeTimeWindow(
          expanded,
          expandedRange,
          service.config,
          selected ? [selected] : [],
          observedAt
        ),
        shortestMetadataSegment: selected
          ? {
              metadataDurationSeconds:
                (Date.parse(selected.endAt) - Date.parse(selected.startAt)) /
                1000,
              ...(suppliedDuration?.success
                ? compareFileDuration(selected, suppliedDuration.data)
                : {}),
            }
          : null,
        timeSemanticsVerified: false,
        mediaAnchorVerified: false,
        mediaRequests: 0,
        nextStep:
          "在设备原生客户端核对同一文件开头及一处可信事件的设备时间，并记录该事件在本播放器内的位置；文件匹配、窄窗响应和时长相同均不能单独证明媒体时间锚点。",
      },
      null,
      2
    )
  )
} catch (error) {
  console.error(
    JSON.stringify(
      error instanceof AppError
        ? { code: error.code, message: error.message }
        : {
            code: "TIME_VERIFICATION_FAILED",
            message: "时间诊断失败，内部详情已隐藏。",
          }
    )
  )
  process.exitCode = 1
}
