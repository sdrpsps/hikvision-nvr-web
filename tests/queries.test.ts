import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isCancelledError,
  onlineManager,
  type QueryClient,
} from "@tanstack/react-query"
import { ApiError, requestEmpty, requestJson } from "../lib/api"
import {
  channelsQueryOptions,
  deviceQueryOptions,
  recordingsQueryOptions,
} from "../lib/api-queries"
import { createQueryClient, getQueryClient } from "../lib/query-client"
import { deviceSchema } from "../shared/contracts"

const channels = {
  timeZone: "Asia/Shanghai",
  today: "2026-10-17",
  channels: [{ id: "101", name: "测试通道", configuredEnabled: true }],
}
const clients: QueryClient[] = []
function client() {
  const value = createQueryClient()
  clients.push(value)
  return value
}
afterEach(() => {
  for (const value of clients.splice(0)) value.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  onlineManager.setOnline(true)
})

describe("client API query lifecycle", () => {
  it("isolates server renders instead of sharing their query caches", () => {
    const first = getQueryClient(),
      second = getQueryClient()
    clients.push(first, second)
    first.setQueryData(["private-test"], "first render")
    expect(second.getQueryData(["private-test"])).toBeUndefined()
  })

  it("deduplicates concurrent channel reads and reuses their fresh cache", async () => {
    const fetcher = vi.fn(async () => Response.json(channels))
    vi.stubGlobal("fetch", fetcher)
    const queryClient = client()
    const values = await Promise.all([
      queryClient.fetchQuery(channelsQueryOptions()),
      queryClient.fetchQuery(channelsQueryOptions()),
    ])
    expect(values).toEqual([channels, channels])
    await expect(
      queryClient.fetchQuery(channelsQueryOptions())
    ).resolves.toEqual(channels)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("still reads the local API when the browser reports no internet connection", async () => {
    onlineManager.setOnline(false)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(channels))
    )
    await expect(client().fetchQuery(channelsQueryOptions())).resolves.toEqual(
      channels
    )
  })

  it("keeps each track and date's recording result independent", async () => {
    const fetcher = vi.fn(async (path: string) => {
      const params = new URL(path, "http://app.test").searchParams
      return Response.json({
        trackId: params.get("track"),
        date: params.get("date"),
        timeZone: "Asia/Shanghai",
        range: {
          startAt: "2026-10-16T16:00:00Z",
          endAt: "2026-10-17T16:00:00Z",
        },
        segments: [],
        coverage: [],
        gaps: [],
        warnings: [],
      })
    })
    vi.stubGlobal("fetch", fetcher)
    const queryClient = client()
    const params = [
      { track: "101", date: "2026-10-17" },
      { track: "201", date: "2026-10-17" },
      { track: "101", date: "2026-10-18" },
    ]
    await Promise.all(
      params.map((value) =>
        queryClient.fetchQuery(recordingsQueryOptions(value))
      )
    )
    for (const value of params)
      expect(
        queryClient.getQueryData(recordingsQueryOptions(value).queryKey)
      ).toMatchObject({
        trackId: value.track,
        date: value.date,
      })
  })

  it("aborts a cancelled request and can fetch the same query again", async () => {
    let activeSignal: AbortSignal | undefined
    const fetcher = vi.fn(
      (_path: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          activeSignal = init.signal ?? undefined
          activeSignal?.addEventListener(
            "abort",
            () => reject(activeSignal?.reason),
            { once: true }
          )
        })
    )
    vi.stubGlobal("fetch", fetcher)
    const queryClient = client()
    const options = channelsQueryOptions()
    const pending = queryClient
      .fetchQuery(options)
      .catch((error: unknown) => error)
    await queryClient.cancelQueries({ queryKey: options.queryKey })
    expect(activeSignal?.aborted).toBe(true)
    expect(isCancelledError(await pending)).toBe(true)
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined()
    fetcher.mockImplementation(async () => Response.json(channels))
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(channels)
  })

  it("surfaces authentication errors without automatically retrying them", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { code: "NVR_AUTH_FAILED", message: "设备认证失败。" } },
        { status: 401 }
      )
    )
    vi.stubGlobal("fetch", fetcher)
    await expect(
      client().fetchQuery(channelsQueryOptions())
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "设备认证失败。",
      status: 401,
      code: "NVR_AUTH_FAILED",
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(["{broken", JSON.stringify({ model: "missing firmware" })])(
    "rejects malformed or incomplete JSON: %s",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body))
      )
      await expect(
        requestJson("/api/device", deviceSchema)
      ).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        message: "服务响应不完整，请检查设备接口。",
      })
    }
  )

  it("preserves a timeout while reading a response body", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Timed out", "TimeoutError")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          controller.abort(reason)
          throw reason
        },
      }))
    )
    await expect(
      requestJson("/api/device", deviceSchema, { signal: controller.signal })
    ).rejects.toBe(reason)
  })

  it("times out device details after ten seconds and offers a retryable error", async () => {
    vi.useFakeTimers()
    // Node's native AbortSignal.timeout uses real timers, so simulate its clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        milliseconds
      )
      return controller.signal
    })
    const fetcher = vi.fn(
      (_path: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true }
          )
        })
    )
    vi.stubGlobal("fetch", fetcher)
    const result = client()
      .fetchQuery(deviceQueryOptions())
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({
      message: "设备信息读取超时，请重试。",
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("accepts an empty DELETE response and reports a failed release", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetcher)
    await expect(
      requestEmpty("/api/streams/test", { method: "DELETE", keepalive: true })
    ).resolves.toBeUndefined()
    fetcher.mockImplementation(async () =>
      Response.json(
        { error: { code: "STREAM_NOT_FOUND", message: "会话已关闭。" } },
        { status: 404 }
      )
    )
    await expect(
      requestEmpty("/api/streams/test", { method: "DELETE" })
    ).rejects.toBeInstanceOf(ApiError)
  })
})
