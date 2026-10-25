import { app } from "@/server/app"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// A Web Request/Response adapter only; all business routing belongs to Hono.
export function GET(request: Request) {
  return app.fetch(request)
}

export const POST = GET
export const DELETE = GET

export const PUT = GET
