import { readFileSync } from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { splitFragmentedMp4 } from "../../server/mp4"
import { selectDate } from "./controls"

const channels = {
  timeZone: "Asia/Shanghai",
  today: "2026-10-17",
  channels: [{ id: "101", name: "测试摄像头", configuredEnabled: true }],
}

function recordings(date = channels.today, count = 1) {
  const start = Date.parse(`${date}T00:00:00+08:00`)
  const range = {
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + 86_400_000).toISOString(),
  }
  const segments = Array.from({ length: count }, (_, index) => ({
    id: (index ? "b" : "a").repeat(32),
    startAt: new Date(start + index * 3_600_000).toISOString(),
    endAt: new Date(start + (index + 1) * 3_600_000).toISOString(),
    codec: "H.264-BP",
  }))
  return {
    trackId: "101",
    date,
    timeZone: channels.timeZone,
    range,
    segments,
    coverage: segments,
    gaps: [],
    warnings: [],
  }
}

async function mockChannels(page: Page) {
  await page.route("**/api/channels", (route) =>
    route.fulfill({ json: channels })
  )
}

async function observeQueryCancellation(page: Page, prefix: string) {
  await page.addInitScript((prefix) => {
    const aborted: string[] = []
    Object.assign(window, { abortedApiQueries: aborted })
    const original = window.fetch
    window.fetch = function (input, init) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.includes(prefix))
        init?.signal?.addEventListener("abort", () => aborted.push(url), {
          once: true,
        })
      return original.call(this, input, init)
    }
  }, prefix)
}

function abortedQueries(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { abortedApiQueries: string[] }).abortedApiQueries
  )
}

test("channel queries share a cache across routes and manual refresh fetches again", async ({
  page,
}) => {
  let channelRequests = 0
  let channelsReachable = true
  const streamRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/streams/"))
      streamRequests.push(request.url())
  })
  await page.route("**/api/channels", (route) => {
    channelRequests++
    if (!channelsReachable)
      return route.fulfill({
        status: 502,
        json: {
          error: { code: "NVR_UNREACHABLE", message: "刷新通道失败。" },
        },
      })
    return route.fulfill({ json: channels })
  })
  await page.route("**/api/recordings?**", (route) =>
    route.fulfill({ json: recordings() })
  )
  await page.goto("/")
  await expect(page.getByLabel("窗口 1 通道", { exact: true })).toContainText(
    "测试摄像头"
  )
  // Development StrictMode may cancel and restart the initial observer. Once
  // data is available, navigation must reuse it without another network read.
  const initialRequests = channelRequests
  expect(initialRequests).toBeGreaterThan(0)
  await page.getByRole("link", { name: "录像回放", exact: true }).click()
  await expect(page.getByText("1 个录像片段")).toBeVisible()
  expect(channelRequests).toBe(initialRequests)
  await page.getByRole("link", { name: "实时预览", exact: true }).click()
  await expect(page.getByLabel("窗口 1 通道", { exact: true })).toContainText(
    "测试摄像头"
  )
  expect(channelRequests).toBe(initialRequests)
  await page.getByRole("button", { name: "刷新通道", exact: true }).click()
  await expect.poll(() => channelRequests).toBe(initialRequests + 1)
  expect(streamRequests).toEqual([])
  channelsReachable = false
  await page.getByRole("button", { name: "刷新通道", exact: true }).click()
  const errorToast = page.locator('[data-sonner-toast][data-type="error"]')
  await expect(errorToast).toContainText("通道读取失败")
  const failedRequests = channelRequests
  await errorToast.getByRole("button", { name: "关闭提示" }).click()
  await expect(errorToast).toHaveCount(0)
  // An error invalidates the cache in this Query version. Remounting reads
  // again; the new page must report the failure with one notification.
  await page.getByRole("link", { name: "录像回放", exact: true }).click()
  await expect(errorToast).toHaveCount(1)
  await expect(errorToast).toContainText("录像查询失败")
  await expect(errorToast).toContainText("刷新通道失败。")
  expect(channelRequests).toBeGreaterThan(failedRequests)
})

test("switching dates aborts the previous query and ignores its late result", async ({
  page,
}) => {
  await observeQueryCancellation(page, "/api/recordings?")
  await mockChannels(page)
  let releasePrevious!: () => void
  const previous = new Promise<void>((resolve) => {
    releasePrevious = resolve
  })
  let previousStarted = false
  await page.route("**/api/recordings?**", async (route) => {
    const date = new URL(route.request().url()).searchParams.get("date")!
    if (date === "2026-10-16") {
      previousStarted = true
      await previous
      await route.fulfill({ json: recordings(date, 0) }).catch(() => {})
      return
    }
    return route.fulfill({
      json: recordings(date, date === "2026-10-15" ? 2 : 1),
    })
  })
  try {
    await page.goto("/playback")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    await selectDate(page, "2026-10-16")
    await expect.poll(() => previousStarted).toBe(true)
    await selectDate(page, "2026-10-15")
    await expect(page.getByText("2 个录像片段")).toBeVisible()
    await expect
      .poll(async () =>
        (await abortedQueries(page)).some((url) =>
          url.includes("date=2026-10-16")
        )
      )
      .toBe(true)
    releasePrevious()
    await page.waitForTimeout(100)
    await expect(page.getByText("2 个录像片段")).toBeVisible()
    await expect(page.getByText("这一天没有检索到录像")).toHaveCount(0)
  } finally {
    releasePrevious()
  }
})

test("closing pending device details aborts their query and reopening recovers", async ({
  page,
}) => {
  await observeQueryCancellation(page, "/api/device")
  await mockChannels(page)
  await page.route("**/api/recordings?**", (route) =>
    route.fulfill({ json: recordings() })
  )
  let releasePrevious!: () => void
  const previous = new Promise<void>((resolve) => {
    releasePrevious = resolve
  })
  let requests = 0
  let recovered = false
  await page.route("**/api/device", async (route) => {
    requests++
    if (!recovered) await previous
    await route
      .fulfill({ json: { model: "TEST-NVR", firmware: "TEST" } })
      .catch(() => {})
  })
  try {
    await page.goto("/playback")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    expect(requests).toBe(0)
    const details = page.getByRole("button", { name: "设备信息", exact: true })
    await details.click()
    await expect(
      page.getByText("正在读取设备信息…", { exact: true })
    ).toBeVisible()
    await expect.poll(() => requests).toBeGreaterThan(0)
    const abortedBeforeClose = (await abortedQueries(page)).length
    await page.keyboard.press("Escape")
    await expect
      .poll(async () => (await abortedQueries(page)).length)
      .toBeGreaterThan(abortedBeforeClose)
    recovered = true
    const requestsBeforeReopen = requests
    await details.click()
    await expect(page.getByText("TEST-NVR", { exact: true })).toBeVisible()
    expect(requests).toBeGreaterThan(requestsBeforeReopen)
    releasePrevious()
    await expect(page.getByText("1 个录像片段")).toBeVisible()
  } finally {
    releasePrevious()
  }
})

for (const failure of ["unauthorized", "network", "invalid-json"] as const) {
  test(`recording ${failure} errors do not retry automatically and recover with refresh`, async ({
    page,
  }) => {
    await mockChannels(page)
    let requests = 0
    let recovered = false
    await page.route("**/api/recordings?**", (route) => {
      requests++
      if (recovered) return route.fulfill({ json: recordings(undefined, 0) })
      if (failure === "network") return route.abort("internetdisconnected")
      if (failure === "invalid-json")
        return route.fulfill({
          contentType: "application/json",
          body: "{broken",
        })
      return route.fulfill({
        status: 401,
        json: { error: { code: "NVR_AUTH_FAILED", message: "查询认证失败。" } },
      })
    })
    await page.goto("/playback")
    const errorToast = page.locator('[data-sonner-toast][data-type="error"]')
    await expect(errorToast).toHaveCount(1)
    await expect(errorToast).toContainText("录像查询失败")
    if (failure === "unauthorized")
      await expect(
        errorToast.getByText("查询认证失败。", { exact: true })
      ).toBeVisible()
    await page.waitForTimeout(1500)
    expect(requests).toBe(1)
    recovered = true
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await expect(page.getByText("这一天没有检索到录像")).toBeVisible()
    expect(requests).toBe(2)
    await expect(errorToast).toHaveCount(0)
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0)
  })
}

test("refreshing recordings releases the current playback and requests a new snapshot", async ({
  page,
}) => {
  await mockChannels(page)
  let queryRequests = 0
  let deleted = 0
  let creates = 0
  const id = "11111111-1111-4111-8111-111111111111"
  const media = splitFragmentedMp4(
    readFileSync(
      new URL("../../fixtures/synthetic-preview.mp4", import.meta.url)
    )
  )
  await page.route("**/api/recordings?**", (route) => {
    queryRequests++
    return route.fulfill({
      json: recordings(undefined, queryRequests === 1 ? 1 : 2),
    })
  })
  await page.route("**/api/streams/**", (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === "POST") {
      creates++
      return route.fulfill({
        status: 201,
        json: {
          id,
          playlistUrl: `/api/streams/${id}/index.m3u8`,
          durationSeconds: 3,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          mode: "stream-copy",
          codec: "h264",
        },
      })
    }
    if (request.method() === "DELETE") {
      deleted++
      return route.fulfill({ status: 204 })
    }
    if (path.endsWith("/status"))
      return route.fulfill({ json: { complete: true, durationSeconds: 3 } })
    if (path.endsWith("index.m3u8"))
      return route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3,\n0.m4s\n#EXT-X-ENDLIST\n',
      })
    return route.fulfill({
      contentType: path.endsWith("init.mp4")
        ? "video/mp4"
        : "video/iso.segment",
      body: path.endsWith("init.mp4") ? media.init : media.media,
    })
  })
  await page.goto("/playback")
  await page.locator(".timeline-segment").first().click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "关闭回放", exact: true })
  ).toBeVisible()
  expect(creates).toBe(1)
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  await expect.poll(() => deleted).toBe(1)
  await expect(page.getByText("2 个录像片段")).toBeVisible()
  expect(queryRequests).toBe(2)
  expect(creates).toBe(1)
  await expect(page.locator("video")).toHaveCount(0)
  await expect(page.getByText("已选片段", { exact: true })).toHaveCount(0)
})
