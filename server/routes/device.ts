import { Hono } from "hono"
import { deviceSchema } from "../../shared/contracts"
import type { NvrService } from "../recordings"

export function createDeviceRoutes(getService: () => NvrService) {
  const routes = new Hono()
  routes.get("/health", (c) => c.json({ status: "ok" }))
  routes.get("/device", async (c) =>
    c.json(deviceSchema.parse(await getService().device()))
  )
  return routes
}
