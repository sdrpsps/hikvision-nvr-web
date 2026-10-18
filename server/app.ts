import { Hono } from "hono"
import {
  channelsSchema,
  deviceSchema,
  recordingsQuerySchema,
  recordingsSchema,
} from "../shared/contracts"
import { readNvrConfig } from "./config"
import { AppError } from "./errors"
import { NvrService } from "./recordings"
import { todayIn } from "./time"

export function createApp(getService: () => NvrService = defaultService) {
  const app = new Hono().basePath("/api")
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("X-Content-Type-Options", "nosniff")
    // No CORS: the browser uses the same Next.js origin.
    await next()
  })
  app.get("/health", (c) => c.json({ status: "ok" }))
  app.get("/device", async (c) =>
    c.json(deviceSchema.parse(await getService().device()))
  )
  app.get("/channels", async (c) => {
    const service = getService(),
      timeZone = service.config.NVR_TIME_ZONE
    return c.json(
      channelsSchema.parse({
        channels: await service.channels(),
        timeZone,
        today: todayIn(timeZone),
      })
    )
  })
  app.get("/recordings", async (c) => {
    const params = new URL(c.req.url).searchParams
    const parsed = recordingsQuerySchema.safeParse(Object.fromEntries(params))
    if (
      !parsed.success ||
      [...params.keys()].some((key) => params.getAll(key).length !== 1)
    )
      throw new AppError(
        "INVALID_QUERY",
        400,
        "请提供合法的轨道和日期，不接受其他参数。"
      )
    return c.json(
      recordingsSchema.parse(
        await getService().recordings(parsed.data.track, parsed.data.date)
      )
    )
  })
  app.notFound((c) =>
    c.json({ error: { code: "NOT_FOUND", message: "接口不存在。" } }, 404)
  )
  app.onError((error, c) => {
    if (error instanceof AppError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status
      )
    // Never log upstream errors or raw XML/URI/headers.
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "查询处理失败，请检查设备响应或服务端配置。",
        },
      },
      500
    )
  })
  return app
}
let service: NvrService | undefined
function defaultService() {
  return (service ??= new NvrService(readNvrConfig()))
}
export const app = createApp()
