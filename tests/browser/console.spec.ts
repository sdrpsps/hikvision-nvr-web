import { test, expect } from "@playwright/test"
import { selectDate, selectOption } from "./controls"

const range = { startAt: "2026-10-16T16:00:00Z", endAt: "2026-10-17T16:00:00Z" }
const segment = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  startAt: range.startAt,
  endAt: "2026-10-16T17:00:00Z",
  codec: "H.264-BP",
}
const data = {
  trackId: "101",
  date: "2026-10-17",
  timeZone: "Asia/Shanghai",
  range,
  segments: [segment],
  coverage: [segment],
  gaps: [{ startAt: segment.endAt, endAt: range.endAt }],
  warnings: [],
}

for (const mobile of [false, true]) {
  test(`query/selection/zoom/empty/error/race ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 375, height: 812 })
    const requests: string[] = []
    let finishPrevious: (() => void) | undefined
    await page.route("**/api/device", (route) =>
      route.fulfill({ json: { model: "TEST-NVR", firmware: "TEST" } })
    )
    await page.route("**/api/channels", (route) =>
      route.fulfill({
        json: {
          timeZone: "Asia/Shanghai",
          today: "2026-10-17",
          channels: [
            { id: "101", name: "轨道 101", configuredEnabled: false },
            { id: "201", name: "轨道 201", configuredEnabled: true },
          ],
        },
      })
    )
    await page.route("**/api/recordings?**", async (route) => {
      const url = new URL(route.request().url())
      requests.push(url.search)
      if (url.searchParams.get("date") === "2026-10-15")
        return route.fulfill({
          status: 504,
          json: { error: { code: "NVR_TIMEOUT", message: "设备查询超时。" } },
        })
      if (url.searchParams.get("track") === "201")
        return route.fulfill({
          json: {
            ...data,
            trackId: "201",
            segments: [],
            coverage: [],
            gaps: [range],
          },
        })
      if (url.searchParams.get("date") === "2026-10-16") {
        await new Promise<void>((resolve) => {
          finishPrevious = resolve
        })
        return route.fulfill({
          json: {
            ...data,
            date: "2026-10-16",
            segments: [],
            coverage: [],
            gaps: [range],
          },
        })
      }
      finishPrevious?.()
      return route.fulfill({ json: data })
    })
    await page.goto("/playback")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    const listToggle = page.getByRole("button", {
      name: "片段列表",
      exact: true,
    })
    await expect(listToggle).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator(".segment-row")).toHaveCount(0)
    await listToggle.focus()
    await page.keyboard.press("Enter")
    const listItem = page.getByRole("button", {
      name: "选择片段 1，00:00:00 至 01:00:00",
      exact: true,
    })
    await listItem.focus()
    await page.keyboard.press("Enter")
    await expect(listItem).toHaveAttribute("aria-pressed", "true")
    const bar = page.getByRole("button", {
      name: "片段 1，00:00:00 至 01:00:00",
      exact: true,
    })
    await bar.click()
    await expect(page.getByText("已选片段")).toBeVisible()
    await expect(bar).toHaveAttribute("aria-pressed", "true")
    const oldWidth = await page
      .locator(".timeline-chart")
      .evaluate((el) => el.getBoundingClientRect().width)
    await page
      .getByRole("group", { name: "时间轴缩放" })
      .getByRole("button", { name: "4 倍" })
      .click()
    expect(
      await page
        .locator(".timeline-chart")
        .evaluate((el) => el.getBoundingClientRect().width)
    ).toBeGreaterThan(oldWidth)
    const timeline = page.getByRole("region", {
      name: "全天录像时间轴，可横向滚动",
      exact: true,
    })
    await expect(timeline).toHaveAttribute("data-slot", "scroll-area-viewport")
    await expect(timeline).toHaveAttribute("tabindex", "0")
    expect(
      await timeline.evaluate(
        (element) => element.scrollWidth > element.clientWidth
      )
    ).toBe(true)
    await timeline.evaluate((element) => {
      element.scrollLeft = 0
    })
    await timeline.focus()
    await page.keyboard.press("ArrowRight")
    await expect
      .poll(() => timeline.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)
    await expect(
      page.locator(
        '.timeline-scroll-area [data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]'
      )
    ).toBeVisible()
    await selectOption(page, "摄像头", "轨道 201")
    await expect(page.getByText("这一天没有检索到录像")).toBeVisible()
    await selectOption(page, "摄像头", "轨道 101")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    await selectDate(page, "2026-10-15")
    await expect(page.getByText("设备查询超时。")).toBeVisible()
    await selectDate(page, "2026-10-16")
    await expect(
      page.getByRole("status", { name: "正在查询录像" })
    ).toBeVisible()
    await selectDate(page, "2026-10-17")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    await page.waitForTimeout(350)
    await expect(page.getByText("这一天没有检索到录像")).toHaveCount(0)
    expect(requests.some((query) => query.includes("date=2026-10-15"))).toBe(
      true
    )
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
  })
}

test("device disconnect has a retryable error", async ({ page }) => {
  let reachable = false
  await page.route("**/api/**", (route) => {
    if (!reachable)
      return route.fulfill({
        status: 502,
        json: { error: { code: "NVR_UNREACHABLE", message: "无法连接设备。" } },
      })
    return route.fulfill({
      json:
        new URL(route.request().url()).pathname === "/api/channels"
          ? {
              timeZone: "Asia/Shanghai",
              today: data.date,
              channels: [
                { id: "101", name: "测试摄像头", configuredEnabled: true },
              ],
            }
          : data,
    })
  })
  await page.goto("/playback")
  await expect(page.getByText("录像查询失败")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "刷新", exact: true })
  ).toBeEnabled()
  reachable = true
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  await expect(page.getByText("1 个录像片段")).toBeVisible()
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0)
})

test("device details load on demand and failures do not block recording queries", async ({
  page,
}) => {
  let deviceRequests = 0
  let deviceReachable = false
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: data.date,
        channels: [{ id: "101", name: "测试摄像头", configuredEnabled: false }],
      },
    })
  )
  await page.route("**/api/recordings?**", (route) =>
    route.fulfill({ json: data })
  )
  await page.route("**/api/device", (route) => {
    deviceRequests += 1
    return !deviceReachable
      ? route.fulfill({
          status: 502,
          json: {
            error: { code: "NVR_UNREACHABLE", message: "设备信息暂时不可用。" },
          },
        })
      : route.fulfill({ json: { model: "TEST-NVR", firmware: "TEST" } })
  })
  await page.goto("/playback")
  await expect(page.getByText("1 个录像片段")).toBeVisible()
  expect(deviceRequests).toBe(0)
  const deviceDetails = page.getByRole("button", {
    name: "设备信息",
    exact: true,
  })
  await expect(
    page
      .locator(".console-header")
      .getByRole("button", { name: "设备信息", exact: true })
  ).toHaveCount(0)
  await expect(
    page
      .locator(".query-actions")
      .getByRole("button", { name: "设备信息", exact: true })
  ).toBeVisible()
  await expect(deviceDetails).toHaveText("设备信息")
  await expect(page.getByText("北京时间", { exact: true })).toHaveCount(0)
  await deviceDetails.click()
  await expect(page.getByText("设备信息读取失败")).toBeVisible()
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0)
  // Cancelled development mounts do not mean the device has recovered.
  const failedRequests = deviceRequests
  deviceReachable = true
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect(page.getByText("TEST-NVR")).toBeVisible()
  await expect(
    page.getByText("北京时间（UTC+8）", { exact: true })
  ).toBeVisible()
  expect(deviceRequests).toBe(failedRequests + 1)
  await page.keyboard.press("Escape")
  await expect(page.getByText("1 个录像片段")).toBeVisible()
  await expect(deviceDetails).toBeFocused()
  await deviceDetails.click()
  await expect(page.getByText("TEST-NVR")).toBeVisible()
  expect(deviceRequests).toBe(failedRequests + 1)
})

test("today's gap summary counts elapsed gaps and excludes future hours", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-17T04:00:00Z"))
  const earlier = { ...segment, endAt: "2026-10-17T02:00:00Z" }
  const later = {
    ...segment,
    id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    startAt: "2026-10-17T03:00:00Z",
    endAt: "2026-10-17T04:00:00Z",
  }
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: data.date,
        channels: [{ id: "101", name: "测试摄像头", configuredEnabled: true }],
      },
    })
  )
  await page.route("**/api/recordings?**", (route) =>
    route.fulfill({
      json: {
        ...data,
        segments: [earlier, later],
        coverage: [earlier, later],
        gaps: [
          { startAt: earlier.endAt, endAt: later.startAt },
          { startAt: later.endAt, endAt: range.endAt },
        ],
      },
    })
  )
  await page.goto("/playback")
  const summary = page.locator(".coverage-summary")
  await expect(summary).toContainText("11 小时 0 分")
  await expect(summary).toContainText("缺口 1 处")
  await expect(summary).toContainText("截至本次查询")
})

test("Beijing labels and day end ignore the browser time zone and old time notices", async ({
  browser,
}) => {
  const context = await browser.newContext({
    timezoneId: "America/Los_Angeles",
  })
  try {
    const page = await context.newPage()
    const requestedDates: string[] = []
    await page.route("**/api/device", (route) =>
      route.fulfill({ json: { model: "TEST", firmware: "TEST" } })
    )
    await page.route("**/api/channels", (route) =>
      route.fulfill({
        json: {
          timeZone: "Asia/Shanghai",
          today: "2026-10-17",
          channels: [
            { id: "101", name: "合成测试通道", configuredEnabled: false },
          ],
        },
      })
    )
    const fullDay = { ...segment, endAt: range.endAt }
    await page.route("**/api/recordings?**", (route) => {
      requestedDates.push(
        new URL(route.request().url()).searchParams.get("date") ?? ""
      )
      return route.fulfill({
        json: {
          ...data,
          segments: [fullDay],
          coverage: [fullDay],
          gaps: [],
          // A stale server response must not reintroduce the removed notice.
          warnings: ["FUTURE_RECORDING_TIME"],
        },
      })
    })
    await page.goto("/playback")
    await expect(page.getByLabel("日期", { exact: true })).toContainText(
      "2026-10-17"
    )
    await expect(page.getByText("录像时间需要核对")).toHaveCount(0)
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0)
    const bar = page.getByRole("button", {
      name: "片段 1，00:00:00 至 24:00:00",
      exact: true,
    })
    await expect(bar).toBeVisible()
    await bar.click()
    await expect(page.locator(".selected-segment strong")).toHaveText(
      "00:00:00 — 24:00:00"
    )
    await expect(page.locator(".coverage-summary")).toContainText(
      "24 小时 0 分"
    )
    await expect(page.locator(".coverage-summary")).not.toContainText("缺口")
    await selectDate(page, "2025-12-31")
    await expect.poll(() => requestedDates.at(-1)).toBe("2025-12-31")
    await page.getByRole("button", { name: "日期", exact: true }).click()
    await expect(page.getByRole("gridcell", { selected: true })).toContainText(
      "31"
    )
    await expect(page.locator("select:visible, input[type=date]")).toHaveCount(
      0
    )
    await page.screenshot({
      path: test.info().outputPath("shadcn-calendar.png"),
      fullPage: true,
      animations: "disabled",
    })
    await page.keyboard.press("Escape")
    await expect(
      page.getByRole("button", { name: "日期", exact: true })
    ).toBeFocused()
  } finally {
    await context.close()
  }
})

test("real LAN acceptance: track 101 / 2026-10-17", async ({ page }) => {
  test.skip(
    process.env.NVR_INTEGRATION !== "1",
    "Explicit local integration opt-in required"
  )
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.name))
  await page.goto("/playback")
  await expect(page.getByLabel("日期", { exact: true })).toBeEnabled()
  await selectDate(page, "2026-10-17")
  const response = await page.request.get(
    "/api/recordings?track=101&date=2026-10-17"
  )
  expect(response.status()).toBe(200)
  const body = await response.text()
  const recordings = JSON.parse(body) as { segments: unknown[] }
  expect(recordings.segments.length).toBeGreaterThan(0)
  await expect(
    page.getByText(`${recordings.segments.length} 个录像片段`)
  ).toBeVisible()
  await expect(page.locator(".timeline-segment")).toHaveCount(
    recordings.segments.length
  )
  await page.getByRole("button", { name: "片段列表", exact: true }).click()
  await expect(page.locator(".segment-list li")).toHaveCount(
    recordings.segments.length
  )
  await page.locator(".timeline-segment").first().click()
  await expect(page.getByText("已选片段")).toBeVisible()
  expect(body).not.toMatch(/rtsp:|playbackURI|serialNumber|Authorization/)
  expect(errors).toEqual([])
})
