import { test, expect } from "@playwright/test"

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
        await new Promise((resolve) => setTimeout(resolve, 250))
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
      return route.fulfill({ json: data })
    })
    await page.goto("/playback")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    await expect(page.getByText("历史文件预览")).toBeVisible()
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
    await page.getByLabel("时间轴缩放").selectOption("4")
    expect(
      await page
        .locator(".timeline-chart")
        .evaluate((el) => el.getBoundingClientRect().width)
    ).toBeGreaterThan(oldWidth)
    await page.getByLabel("录像轨道").selectOption("201")
    await expect(page.getByText("这一天没有检索到录像")).toBeVisible()
    await page.getByLabel("录像轨道").selectOption("101")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    await page.getByLabel("设备日期").fill("2026-10-15")
    await expect(page.getByText("设备查询超时。")).toBeVisible()
    await page.getByLabel("设备日期").fill("2026-10-16")
    await expect(
      page.getByRole("status", { name: "正在查询录像" })
    ).toBeVisible()
    await page.getByLabel("设备日期").fill("2026-10-17")
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
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 502,
      json: { error: { code: "NVR_UNREACHABLE", message: "无法连接设备。" } },
    })
  )
  await page.goto("/playback")
  await expect(page.getByText("录像查询失败")).toBeVisible()
  await expect(page.getByRole("button", { name: "重新查询" })).toBeEnabled()
})

test("real LAN acceptance: track 101 / 2026-10-17", async ({ page }) => {
  test.skip(
    process.env.NVR_INTEGRATION !== "1",
    "Explicit local integration opt-in required"
  )
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.name))
  await page.goto("/playback")
  await expect(page.getByLabel("设备日期")).toBeEnabled()
  await page.getByLabel("设备日期").fill("2026-10-17")
  await expect(page.getByText("13 个录像片段")).toBeVisible()
  await expect(page.locator(".timeline-segment")).toHaveCount(13)
  await expect(page.locator(".segment-list li")).toHaveCount(13)
  await page.locator(".timeline-segment").first().click()
  await expect(page.getByText("已选片段")).toBeVisible()
  const response = await page.request.get(
    "/api/recordings?track=101&date=2026-10-17"
  )
  expect(response.status()).toBe(200)
  expect(await response.text()).not.toMatch(
    /rtsp:|playbackURI|serialNumber|Authorization/
  )
  expect(errors).toEqual([])
})
