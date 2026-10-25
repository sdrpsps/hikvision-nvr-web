import { test, expect, type Page } from "@playwright/test"
import { selectDate, selectOption } from "./controls"

async function mockApi(page: Page) {
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(request.url())
  })
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-25",
        channels: [
          { id: "101", name: "摄像头一", configuredEnabled: true },
          { id: "201", name: "摄像头二", configuredEnabled: true },
        ],
      },
    })
  )
  await page.route("**/api/recordings?**", (route) => {
    const url = new URL(route.request().url())
    return route.fulfill({
      json: {
        trackId: url.searchParams.get("track"),
        date: url.searchParams.get("date"),
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
  })
  return requests
}
function params(page: Page) {
  return new URL(page.url()).searchParams
}

test("playback links restore filters, update URL, and support back/forward and reload", async ({
  page,
}) => {
  await mockApi(page)
  await page.goto("/playback?track=201&date=2026-10-24&zoom=4")
  await expect(
    page.getByRole("combobox", { name: "摄像头", exact: true })
  ).toContainText("摄像头二")
  await expect(
    page.getByRole("button", { name: "日期", exact: true })
  ).toContainText("2026-10-24")
  await expect(
    page.getByRole("button", { name: "4 倍", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("slider", { name: "回放时间轴" })).toBeDisabled()
  await expect(
    page.locator(".playback-player").getByRole("slider")
  ).toHaveCount(1)
  await selectOption(page, "摄像头", "摄像头一")
  await expect.poll(() => params(page).get("track")).toBe("101")
  await selectDate(page, "2026-10-23")
  await expect.poll(() => params(page).get("date")).toBe("2026-10-23")
  await page.goBack()
  await expect(
    page.getByRole("button", { name: "日期", exact: true })
  ).toContainText("2026-10-24")
  await page.goBack()
  await expect(
    page.getByRole("combobox", { name: "摄像头", exact: true })
  ).toContainText("摄像头二")
  await page.goForward()
  await expect(
    page.getByRole("combobox", { name: "摄像头", exact: true })
  ).toContainText("摄像头一")
  await page.getByRole("button", { name: "2 倍", exact: true }).click()
  await expect.poll(() => params(page).get("zoom")).toBe("2")
  await page.reload()
  await expect(
    page.getByRole("button", { name: "2 倍", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("combobox", { name: "摄像头", exact: true })
  ).toContainText("摄像头一")
})

test("live restores wall assignments and sidebar without starting media; UI changes survive reload", async ({
  page,
}) => {
  const requests = await mockApi(page)
  await page.goto("/?layout=2&window=2&slots=1:201,2:101&sidebar=false")
  await expect(page.locator(".video-wall-cell")).toHaveCount(2)
  await expect(page.getByLabel("窗口 1 通道", { exact: true })).toContainText(
    "摄像头二"
  )
  await expect(page.getByLabel("窗口 2 通道", { exact: true })).toContainText(
    "摄像头一"
  )
  await expect(
    page.getByRole("button", { name: "选择窗口 2", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("button", { name: "展开通道", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "展开通道", exact: true }).click()
  await expect.poll(() => params(page).has("sidebar")).toBe(false)
  await page.getByRole("button", { name: "1 路", exact: true }).click()
  await expect.poll(() => params(page).get("layout")).toBe("1")
  await expect.poll(() => params(page).has("window")).toBe(false)
  await selectOption(page, "窗口 1 通道", "摄像头一")
  await expect.poll(() => params(page).get("slots")).toBe("1:101,2:101")
  await page.reload()
  await expect(page.locator(".video-wall-cell")).toHaveCount(1)
  await expect(page.getByLabel("窗口 1 通道", { exact: true })).toContainText(
    "摄像头一"
  )
  expect(
    requests.some(
      (url) => url.includes("/api/streams") || url.includes("/api/transfers")
    )
  ).toBe(false)
})

test("malformed parameters fall back safely and never reach API inputs", async ({
  page,
}) => {
  const requests = await mockApi(page)
  await page.goto("/playback?track=https://evil.test&date=2026-02-30&zoom=100")
  await expect(
    page.getByRole("combobox", { name: "摄像头", exact: true })
  ).toContainText("摄像头一")
  await expect(
    page.getByRole("button", { name: "日期", exact: true })
  ).toContainText("2026-10-25")
  await expect(
    page.getByRole("button", { name: "全天", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  expect(
    requests
      .filter((url) => url.includes("/api/recordings"))
      .every(
        (url) =>
          new URL(url).searchParams.get("date") === "2026-10-25" &&
          new URL(url).searchParams.get("track") === "101"
      )
  ).toBe(true)
  await page.goto(
    "/?layout=999&window=-1&slots=1:../../private&sidebar=invalid"
  )
  await expect(page.locator(".video-wall-cell")).toHaveCount(4)
  await expect(page.getByLabel("窗口 1 通道", { exact: true })).toContainText(
    "摄像头一"
  )
  await expect(
    page.getByRole("button", { name: "收起通道", exact: true })
  ).toBeVisible()
})
