import type { z } from "zod"
import { errorSchema } from "@/shared/contracts"

export async function getJson<T>(
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal
): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body)
    throw new Error(
      parsed.success
        ? parsed.data.error.message
        : "服务暂时不可用，请稍后重试。"
    )
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new Error("服务响应不完整，请检查设备接口。")
  return parsed.data
}
