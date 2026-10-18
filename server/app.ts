import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { previewRequestSchema, previewSchema } from "../shared/contracts"
import { PreviewSessions } from "./preview"
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

export function createApp(
  getService: () => NvrService = defaultService,
  previews = new PreviewSessions()
) {
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
  app.use("/streams/*", async (c, next) => {
    const origin = c.req.header("origin")
    // Next.js can normalize request.url to localhost; Host retains the browser authority.
    const requestOrigin = new URL(c.req.url)
    requestOrigin.host = c.req.header("host") ?? requestOrigin.host
    if (
      c.req.header("sec-fetch-site") === "cross-site" ||
      (origin && origin !== requestOrigin.origin)
    )
      throw new AppError("MEDIA_ORIGIN_DENIED", 403, "请从本应用页面打开预览。")
    await next()
  })
  app.post(
    "/streams/playback",
    bodyLimit({
      maxSize: 1024,
      onError: (c) =>
        c.json(
          { error: { code: "INVALID_BODY", message: "请求内容过大。" } },
          400
        ),
    }),
    async (c) => {
      if (!c.req.header("content-type")?.startsWith("application/json"))
        throw new AppError("INVALID_BODY", 400, "请使用 JSON 请求。")
      const parsed = previewRequestSchema.safeParse(
        await c.req.json().catch(() => undefined)
      )
      if (!parsed.success)
        throw new AppError(
          "INVALID_BODY",
          400,
          "请提供合法轨道、日期和录像 ID。"
        )
      const service = getService(),
        { track, date, segmentId } = parsed.data
      return c.json(
        previewSchema.parse(
          await previews.create(
            service.config,
            () => service.resolveSegment(track, date, segmentId),
            c.req.raw.signal
          )
        ),
        201
      )
    }
  )
  app.get("/streams/:id/:asset", (c) => {
    const id = c.req.param("id"),
      asset = c.req.param("asset")
    if (asset === "index.m3u8")
      return c.body(previews.playlist(id), 200, {
        "Content-Type": "application/vnd.apple.mpegurl",
      })
    if (asset !== "init.mp4" && asset !== "segment.m4s")
      throw new AppError("MEDIA_NOT_FOUND", 404, "媒体资源不存在。")
    const media = previews.get(id),
      data = asset === "init.mp4" ? media.init : media.media
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": asset === "init.mp4" ? "video/mp4" : "video/iso.segment",
    })
  })
  app.delete("/streams/:id", (c) => {
    previews.delete(c.req.param("id"))
    return c.body(null, 204)
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
