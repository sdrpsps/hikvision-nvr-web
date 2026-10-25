import { Hono } from "hono"
import { recordingsQuerySchema, recordingsSchema } from "../../shared/contracts"
import { AppError } from "../errors"
import type { NvrService } from "../recordings"

export function createRecordingRoutes(getService: () => NvrService) {
  const routes = new Hono()
  routes.get("/", async (c) => {
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
  return routes
}
