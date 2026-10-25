import { Hono } from "hono"
import {
  channelsSchema,
  renameChannelSchema,
  trackIdSchema,
} from "../../shared/contracts"
import { AppError } from "../errors"
import type { NvrService } from "../recordings"
import { todayIn } from "../time"
import { assertSameOrigin, jsonBodyLimit, requireJson } from "./http"

export function createChannelRoutes(getService: () => NvrService) {
  const routes = new Hono()
  routes.get("/", async (c) => {
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
  routes.use("/:id/name", jsonBodyLimit())
  routes.put("/:id/name", async (c) => {
    assertSameOrigin(c, "ORIGIN_DENIED", "请从本应用页面修改通道名称。")
    requireJson(c)
    const id = trackIdSchema.safeParse(c.req.param("id"))
    const input = renameChannelSchema.safeParse(
      await c.req.json().catch(() => undefined)
    )
    if (!id.success || !input.success)
      throw new AppError(
        "INVALID_BODY",
        400,
        "请提供合法通道和名称（1–32 个 UTF-8 字节），不接受其他参数。"
      )
    return c.json(
      await getService().renameChannel(id.data, input.data, c.req.raw.signal)
    )
  })
  return routes
}
