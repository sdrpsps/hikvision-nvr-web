import { config } from "dotenv"
import { recordingsQuerySchema } from "../shared/contracts"
import { readNvrConfig } from "../server/config"
import { NvrService } from "../server/recordings"
import { AppError } from "../server/errors"
import { parseDeviceTime } from "../server/xml"

config({ quiet: true })
const query = recordingsQuerySchema.safeParse({
  track: process.argv[2],
  date: process.argv[3],
})
if (!query.success) {
  console.error("用法：pnpm verify:device <track> <YYYY-MM-DD>")
  process.exitCode = 1
} else {
  try {
    const service = new NvrService(readNvrConfig())
    const device = await service.device()
    const channels = await service.channels()
    const result = await service.recordings(query.data.track, query.data.date)
    const time = await service.client
      .request("/ISAPI/System/time")
      .then(parseDeviceTime)
      .catch(() => undefined)
    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          device,
          channels: channels.length,
          configuredDisabled: channels.filter(
            (c) => c.configuredEnabled === false
          ).length,
          track: result.trackId,
          date: result.date,
          timeZone: result.timeZone,
          range: result.range,
          segments: result.segments.length,
          coverage: result.coverage,
          gaps: result.gaps,
          warnings: result.warnings,
          codecs: [...new Set(result.segments.map((s) => s.codec))],
          deviceTime: time ?? "读取失败，尚未核对",
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
              code: "VERIFICATION_FAILED",
              message: "验证未完成，内部详情已隐藏。",
            }
      )
    )
    process.exitCode = 1
  }
}
