import { Hono } from "hono"
import {
  historyTransferRequestSchema,
  liveTransferRequestSchema,
} from "../../shared/contracts"
import { AppError } from "../errors"
import type { NvrService } from "../recordings"
import type { MediaTransfers } from "../transfer"
import { jsonBodyLimit, requireJson, sameOrigin } from "./http"

export function createTransferRoutes(
  getService: () => NvrService,
  transfers: Pick<MediaTransfers, "history" | "live">
) {
  const routes = new Hono()
  routes.use(
    "*",
    sameOrigin("MEDIA_ORIGIN_DENIED", "请从本应用页面开始录制或下载。")
  )
  routes.use("*", jsonBodyLimit())
  routes.post("/history", async (c) => {
    requireJson(c)
    const parsed = historyTransferRequestSchema.safeParse(
      await c.req.json().catch(() => undefined)
    )
    if (!parsed.success)
      throw new AppError(
        "INVALID_BODY",
        400,
        "请提供合法轨道、日期和录像 ID，不接受其他参数。"
      )
    const service = getService()
    const { track, date, segmentId } = parsed.data
    return transfers.history(
      service.config,
      () => service.resolveSegment(track, date, segmentId),
      c.req.raw.signal
    )
  })
  routes.post("/live", async (c) => {
    requireJson(c)
    const parsed = liveTransferRequestSchema.safeParse(
      await c.req.json().catch(() => undefined)
    )
    if (!parsed.success)
      throw new AppError(
        "INVALID_BODY",
        400,
        "请选择合法通道，不接受其他参数。"
      )
    const service = getService()
    return transfers.live(
      service.config,
      () => service.requireChannel(parsed.data.track),
      c.req.raw.signal
    )
  })
  return routes
}
