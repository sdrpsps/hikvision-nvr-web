import type { z } from "zod"
import { errorSchema } from "../shared/contracts"

type ResponseMessages = { unavailable?: string; invalid?: string }

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = "ApiError"
  }
}

async function readResponse(path: string, init: RequestInit) {
  try {
    return await fetch(path, { cache: "no-store", ...init })
  } catch (error) {
    // Keep cancellation/timeout recognizable to the query and session owners.
    if (init.signal?.aborted) throw init.signal.reason
    throw error
  }
}

async function readJson(response: Response, signal?: AbortSignal | null) {
  try {
    return (await response.json()) as unknown
  } catch {
    if (signal?.aborted) throw signal.reason
    return null
  }
}

function responseError(body: unknown, status: number, fallback?: string) {
  const parsed = errorSchema.safeParse(body)
  return new ApiError(
    parsed.success
      ? parsed.data.error.message
      : (fallback ?? "服务暂时不可用，请稍后重试。"),
    status,
    parsed.success ? parsed.data.error.code : undefined
  )
}

export async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  messages: ResponseMessages = {}
): Promise<T> {
  const response = await readResponse(path, init).catch((error: unknown) => {
    if (init.signal?.aborted) throw error
    throw new ApiError(
      messages.unavailable ?? "无法连接本机服务，请确认服务已启动后重试。",
      0,
      "NETWORK_ERROR"
    )
  })
  const body = await readJson(response, init.signal)
  if (!response.ok)
    throw responseError(body, response.status, messages.unavailable)
  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw new ApiError(
      messages.invalid ?? "服务响应不完整，请检查设备接口。",
      response.status,
      "INVALID_RESPONSE"
    )
  return parsed.data
}

export async function requestEmpty(
  path: string,
  init: RequestInit = {},
  messages: ResponseMessages = {}
): Promise<void> {
  const response = await readResponse(path, init)
  if (!response.ok)
    throw responseError(
      await readJson(response, init.signal),
      response.status,
      messages.unavailable
    )
}
