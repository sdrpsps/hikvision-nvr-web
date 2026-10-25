import { Hono } from "hono"
import {
  liveRequestSchema,
  liveSchema,
  previewRequestSchema,
  previewSchema,
} from "../../shared/contracts"
import { AppError } from "../errors"
import type { LiveSessions } from "../live"
import type { PlaybackSessions } from "../playback"
import type { NvrService } from "../recordings"
import { jsonBodyLimit, requireJson, sameOrigin } from "./http"

export type PreviewRoutes = Pick<
  PlaybackSessions,
  "create" | "playlist" | "status" | "asset" | "delete" | "audio"
>

export function createStreamRoutes(
  getService: () => NvrService,
  previews: PreviewRoutes,
  live: LiveSessions
) {
  const routes = new Hono()
  routes.use("*", sameOrigin("MEDIA_ORIGIN_DENIED", "请从本应用页面打开预览。"))
  routes.post("/live", jsonBodyLimit(), async (c) => {
    requireJson(c)
    const parsed = liveRequestSchema.safeParse(
      await c.req.json().catch(() => undefined)
    )
    if (!parsed.success)
      throw new AppError(
        "INVALID_BODY",
        400,
        "请选择合法通道，不接受其他参数。"
      )
    const service = getService()
    return c.json(
      liveSchema.parse(
        await live.create(
          service.config,
          () => service.requireChannel(parsed.data.track),
          c.req.raw.signal
        )
      ),
      201
    )
  })
  routes.post("/playback", jsonBodyLimit(), async (c) => {
    requireJson(c)
    const parsed = previewRequestSchema.safeParse(
      await c.req.json().catch(() => undefined)
    )
    if (!parsed.success)
      throw new AppError("INVALID_BODY", 400, "请提供合法轨道、日期和录像 ID。")
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
  })
  routes.get("/:id/:asset", async (c) => {
    const id = c.req.param("id"),
      asset = c.req.param("asset")
    if (live.has(id)) {
      if (asset === "audio") {
        const after = c.req.query("after") ?? "-1"
        if (!/^(?:-1|0|[1-9]\d{0,9})$/.test(after))
          throw new AppError("INVALID_QUERY", 400, "音频游标无效。")
        return c.json(live.audio(id, Number(after)))
      }
      if (asset === "index.m3u8")
        return c.body(live.playlist(id), 200, {
          "Content-Type": "application/vnd.apple.mpegurl",
        })
      return c.body(new Uint8Array(live.asset(id, asset)), 200, {
        "Content-Type":
          asset === "init.mp4" ? "video/mp4" : "video/iso.segment",
      })
    }
    if (asset === "status") return c.json(previews.status(id))
    if (asset === "audio") {
      const after = c.req.query("after") ?? "-1",
        at = c.req.query("at") ?? "0"
      if (
        !/^(?:-1|0|[1-9]\d{0,9})$/.test(after) ||
        !/^\d{1,5}(?:\.\d{1,6})?$/.test(at) ||
        Number(at) > 86400
      )
        throw new AppError("INVALID_QUERY", 400, "音频定位参数无效。")
      return c.json(await previews.audio(id, Number(after), Number(at)))
    }
    if (asset === "index.m3u8")
      return c.body(previews.playlist(id), 200, {
        "Content-Type": "application/vnd.apple.mpegurl",
      })
    const data = await previews.asset(id, asset)
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": asset === "init.mp4" ? "video/mp4" : "video/iso.segment",
    })
  })
  routes.delete("/:id", async (c) => {
    live.delete(c.req.param("id"))
    await previews.delete(c.req.param("id"))
    return c.body(null, 204)
  })
  return routes
}
