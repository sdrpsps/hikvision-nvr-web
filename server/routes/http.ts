import type { Context, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { AppError } from "../errors"

export function jsonBodyLimit() {
  return bodyLimit({
    maxSize: 1024,
    onError: (c) =>
      c.json(
        { error: { code: "INVALID_BODY", message: "请求内容过大。" } },
        400
      ),
  })
}

export function requireJson(c: Context) {
  if (!c.req.header("content-type")?.startsWith("application/json"))
    throw new AppError("INVALID_BODY", 400, "请使用 JSON 请求。")
}

export function assertSameOrigin(c: Context, code: string, message: string) {
  const origin = c.req.header("origin")
  // Next.js can normalize request.url to localhost; Host retains the browser authority.
  const target = new URL(c.req.url)
  target.host = c.req.header("host") ?? target.host
  if (
    c.req.header("sec-fetch-site") === "cross-site" ||
    (origin && origin !== target.origin)
  )
    throw new AppError(code, 403, message)
}

export function sameOrigin(code: string, message: string): MiddlewareHandler {
  return async (c, next) => {
    assertSameOrigin(c, code, message)
    await next()
  }
}
