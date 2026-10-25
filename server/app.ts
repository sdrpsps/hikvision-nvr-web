import { Hono } from "hono"
import { readNvrConfig } from "./config"
import { AppError } from "./errors"
import { LiveSessions } from "./live"
import { PlaybackSessions } from "./playback"
import { NvrService } from "./recordings"
import { MediaTransfers } from "./transfer"
import { createDeviceRoutes } from "./routes/device"
import { createChannelRoutes } from "./routes/channels"
import { createRecordingRoutes } from "./routes/recordings"
import { createStreamRoutes, type PreviewRoutes } from "./routes/streams"
import { createTransferRoutes } from "./routes/transfers"

export function createApp(
  getService: () => NvrService = defaultService,
  previews: PreviewRoutes = new PlaybackSessions(),
  live = new LiveSessions(),
  transfers: Pick<MediaTransfers, "history" | "live"> = new MediaTransfers()
) {
  const app = new Hono().basePath("/api")
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("X-Content-Type-Options", "nosniff")
    // No CORS: the browser uses the same Next.js origin.
    await next()
  })
  app.route("/", createDeviceRoutes(getService))
  app.route("/channels", createChannelRoutes(getService))
  app.route("/recordings", createRecordingRoutes(getService))
  app.route("/streams", createStreamRoutes(getService, previews, live))
  app.route("/transfers", createTransferRoutes(getService, transfers))
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
