import { expect, test, type Locator } from "@playwright/test"

async function optionFitsViewport(option: Locator) {
  return option.evaluate((element) => {
    const list = element.closest('[role="listbox"]')!
    const itemBounds = element.getBoundingClientRect()
    const listBounds = list.getBoundingClientRect()
    return (
      itemBounds.top >= listBounds.top - 1 &&
      itemBounds.bottom <= listBounds.bottom + 1 &&
      listBounds.top >= -1 &&
      listBounds.bottom <= innerHeight + 1
    )
  })
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
  { width: 375, height: 320 },
]) {
  test(`64-option select keeps keyboard focus visible at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/api/channels") {
        return route.fulfill({
          json: {
            timeZone: "Asia/Shanghai",
            today: "2026-10-17",
            channels: Array.from({ length: 64 }, (_, index) => ({
              id: String((index + 1) * 100 + 1),
              name: `摄像头 ${index + 1}`,
              configuredEnabled: true,
            })),
          },
        })
      }
      if (url.pathname === "/api/recordings") {
        const range = {
          startAt: "2026-10-16T16:00:00Z",
          endAt: "2026-10-17T16:00:00Z",
        }
        return route.fulfill({
          json: {
            trackId: url.searchParams.get("track"),
            date: url.searchParams.get("date"),
            timeZone: "Asia/Shanghai",
            range,
            segments: [],
            coverage: [],
            gaps: [range],
            warnings: [],
          },
        })
      }
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "MOCK_FAILURE",
            message: "合成测试未提供该接口。",
          },
        },
      })
    })
    await page.goto("/playback")
    const trigger = page.getByRole("combobox", {
      name: "摄像头",
      exact: true,
    })
    const list = page.getByRole("listbox")
    const first = page.getByRole("option", {
      name: "摄像头 1",
      exact: true,
    })
    const last = page.getByRole("option", {
      name: "摄像头 64",
      exact: true,
    })
    await expect(trigger).toBeEnabled()
    await trigger.click()
    await expect(page.getByRole("option")).toHaveCount(64)
    await expect(list).toHaveAttribute("data-slot", "scroll-area-viewport")

    await page.keyboard.press("End")
    await expect(last).toBeFocused()
    await expect.poll(() => optionFitsViewport(last)).toBe(true)
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0)
    expect(
      await list.evaluate(
        (element) =>
          element.closest<HTMLElement>('[data-slot="select-content"]')!
            .scrollTop
      )
    ).toBe(0)

    await page.keyboard.press("Enter")
    await expect(trigger.locator('[data-slot="select-value"]')).toHaveText(
      "摄像头 64"
    )
    await trigger.click()
    await expect(last).toBeFocused()
    await expect.poll(() => optionFitsViewport(last)).toBe(true)

    await page.keyboard.press("Home")
    await expect(first).toBeFocused()
    await expect.poll(() => optionFitsViewport(first)).toBe(true)
    for (let index = 1; index < 64; index++)
      await page.keyboard.press("ArrowDown")
    await expect(last).toBeFocused()
    await expect.poll(() => optionFitsViewport(last)).toBe(true)
    await page.keyboard.press("Escape")
    await expect(trigger).toBeFocused()
    expect(errors).toEqual([])
  })
}
