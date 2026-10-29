import { test, expect } from "@playwright/test"

test("live rename refreshes shared names while playback has no rename action", async ({
  page,
}) => {
  let name = "测试摄像头"
  const writes: unknown[] = []
  let fail = false
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-25",
        channels: [{ id: "701", name, configuredEnabled: true }],
      },
    })
  )
  await page.route("**/api/recordings?**", (route) =>
    route.fulfill({
      json: {
        trackId: "701",
        date: "2026-10-25",
        timeZone: "Asia/Shanghai",
        range: {
          startAt: "2026-10-24T16:00:00Z",
          endAt: "2026-10-25T16:00:00Z",
        },
        segments: [],
        coverage: [],
        gaps: [],
        warnings: [],
      },
    })
  )
  await page.route("**/api/channels/701/name", async (route) => {
    writes.push(route.request().postDataJSON())
    if (fail)
      return route.fulfill({
        status: 502,
        json: {
          error: { code: "NVR_FORBIDDEN", message: "设备账户没有此操作权限。" },
        },
      })
    name = route.request().postDataJSON().name
    await route.fulfill({ json: { id: "701", name } })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "修改通道 701 名称" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("通道名称", { exact: true }).fill("中".repeat(11))
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  expect(writes).toHaveLength(0)
  await dialog.getByLabel("通道名称", { exact: true }).fill("门口 & 院子")
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator(".channel-list")).toContainText("门口 & 院子")
  await expect(
    page.getByRole("combobox", { name: "窗口 1 通道" })
  ).toContainText("门口 & 院子")
  expect(writes).toEqual([{ name: "门口 & 院子" }])
  await page.getByRole("button", { name: "修改通道 701 名称" }).click()
  fail = true
  await dialog.getByLabel("通道名称", { exact: true }).fill("新名称")
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await expect(page.getByText("设备账户没有此操作权限。")).toBeVisible()
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await page.getByRole("link", { name: "录像回放" }).click()
  const channel = page
    .getByRole("complementary", { name: "设备通道", exact: true })
    .getByRole("button", { name: "门口 & 院子", exact: true })
  await expect(channel).toBeVisible()
  await expect(
    page.getByRole("button", { name: /修改通道.*名称/ })
  ).toHaveCount(0)
  await expect(channel).toHaveAttribute("aria-pressed", "true")
})

test("mobile rename cancels without a write and blocks duplicate submissions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let writes = 0
  let release: (() => void) | undefined
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-25",
        channels: [{ id: "101", name: "测试通道", configuredEnabled: null }],
      },
    })
  )
  await page.route("**/api/channels/101/name", async (route) => {
    writes++
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.fulfill({ json: { id: "101", name: "新名称" } })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "修改通道 101 名称" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("通道名称", { exact: true }).fill("取消名称")
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  expect(writes).toBe(0)
  await page.getByRole("button", { name: "修改通道 101 名称" }).click()
  await expect(dialog.getByLabel("通道名称", { exact: true })).toHaveValue(
    "测试通道"
  )
  await dialog.getByLabel("通道名称", { exact: true }).fill("新名称")
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "正在保存…" })).toBeDisabled()
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true })
  ).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect.poll(() => writes).toBe(1)
  release?.()
  await expect(dialog).toBeHidden()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
})
