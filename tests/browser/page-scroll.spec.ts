import { test, expect } from "@playwright/test"

for (const viewportSize of [
  { width: 375, height: 640 },
  { width: 1440, height: 900 },
]) {
  test(`page scroll follows dynamic content and resets when changing pages at ${viewportSize.width}x${viewportSize.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewportSize)
    const range = {
      startAt: "2026-10-16T16:00:00Z",
      endAt: "2026-10-17T16:00:00Z",
    }
    const segments = Array.from({ length: 12 }, (_, index) => ({
      id: (index + 1).toString(16).padStart(32, "a"),
      startAt: new Date(
        Date.parse(range.startAt) + index * 7200000
      ).toISOString(),
      endAt: new Date(
        Date.parse(range.startAt) + (index + 1) * 7200000
      ).toISOString(),
      codec: "H.264",
    }))
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === "/api/channels")
        return route.fulfill({
          json: {
            timeZone: "Asia/Shanghai",
            today: "2026-10-17",
            channels: [
              { id: "101", name: "测试摄像头", configuredEnabled: true },
            ],
          },
        })
      if (path === "/api/recordings")
        return route.fulfill({
          json: {
            trackId: "101",
            date: "2026-10-17",
            timeZone: "Asia/Shanghai",
            range,
            segments,
            coverage: [range],
            gaps: [],
            warnings: [],
          },
        })
      return route.fulfill({ status: 404, body: "" })
    })
    await page.goto("/playback")
    await expect(page.getByText("12 个录像片段")).toBeVisible()
    const viewport = page.locator(".app-scroll-viewport")
    const thumb = page.locator(
      '.app-scroll-area > [data-slot="scroll-area-scrollbar"] [data-slot="scroll-area-thumb"]'
    )
    const initialHeight = await viewport.evaluate((el) => el.scrollHeight)
    const initialThumbHeight = await thumb.evaluate((el) => el.clientHeight)
    await page.getByRole("button", { name: "片段列表", exact: true }).click()
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight))
      .toBeGreaterThan(initialHeight)
    await expect
      .poll(() => thumb.evaluate((el) => el.clientHeight))
      .toBeLessThan(initialThumbHeight)

    await viewport.hover()
    await page.mouse.wheel(0, 1600)
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0)
    await expect(page.locator(".segment-row").last()).toBeInViewport()
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    expect(
      await viewport.evaluate((el) => el.scrollWidth <= el.clientWidth)
    ).toBe(true)

    await page.getByRole("link", { name: "实时预览" }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0)
    await expect(page.locator(".console-header")).toBeInViewport()
    await page.getByRole("link", { name: "录像回放" }).click()
    await expect(page).toHaveURL(/\/playback$/)
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0)
    await expect(page.locator(".console-header")).toBeInViewport()
  })
}
