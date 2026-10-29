import { expect, test, type Page } from "@playwright/test"
import type { Channel } from "../../shared/contracts"

const range = {
  startAt: "2026-10-24T16:00:00.000Z",
  endAt: "2026-10-25T16:00:00.000Z",
}
const segment = {
  id: "a".repeat(32),
  startAt: range.startAt,
  endAt: "2026-10-24T17:00:00.000Z",
}
const sessionId = "55555555-5555-4555-8555-555555555555"

function channels(count: number): Channel[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String((index + 1) * 100 + 1),
    name: `摄像头 ${index + 1}`,
    configuredEnabled: false,
  }))
}

async function mockApi(page: Page, holdChannels = false) {
  let releaseChannels = () => {}
  const channelsReady = holdChannels
    ? new Promise<void>((resolve) => {
        releaseChannels = resolve
      })
    : Promise.resolve()
  let releasePlaylist = () => {}
  const playlistReady = new Promise<void>((resolve) => {
    releasePlaylist = resolve
  })
  const state = {
    channels: channels(2),
    channelError: false,
    channelRequests: 0,
    queries: [] as string[],
    posts: 0,
    deletes: 0,
    unexpected: [] as string[],
    releaseChannels,
    releasePlaylist,
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/api/channels") {
      state.channelRequests++
      await channelsReady
      return state.channelError
        ? route.fulfill({
            status: 401,
            json: {
              error: { code: "NVR_AUTH_FAILED", message: "设备认证失败。" },
            },
          })
        : route.fulfill({
            json: {
              timeZone: "Asia/Shanghai",
              today: "2026-10-25",
              channels: state.channels,
            },
          })
    }
    if (url.pathname === "/api/recordings") {
      state.queries.push(url.search)
      return route.fulfill({
        json: {
          trackId: url.searchParams.get("track"),
          date: url.searchParams.get("date"),
          timeZone: "Asia/Shanghai",
          range,
          segments: [segment],
          coverage: [segment],
          gaps: [],
          warnings: [],
        },
      })
    }
    if (url.pathname === "/api/streams/playback") {
      state.posts++
      return route.fulfill({
        status: 201,
        json: {
          id: sessionId,
          playlistUrl: `/api/streams/${sessionId}/index.m3u8`,
          fileRange: segment,
          startOffsetSeconds: 0,
          estimatedDurationSeconds: 3600,
          durationSeconds: 10,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          mode: "stream-copy",
          codec: "h264",
        },
      })
    }
    if (url.pathname === `/api/streams/${sessionId}`) {
      if (request.method() === "DELETE") {
        state.deletes++
        return route.fulfill({ status: 204 })
      }
    }
    if (url.pathname.endsWith("/status"))
      return route.fulfill({
        json: { complete: false, durationSeconds: 10 },
      })
    if (url.pathname.endsWith("/audio"))
      return route.fulfill({
        json: { status: "unsupported", videoStartSeconds: 0, chunks: [] },
      })
    if (url.pathname.endsWith("/index.m3u8")) {
      await playlistReady
      return route.abort("aborted").catch(() => {})
    }
    state.unexpected.push(`${request.method()} ${url.pathname}`)
    return route.fulfill({ status: 404 })
  })
  return state
}

test("playback channel selection and channel refresh preserve the current session until the track changes", async ({
  page,
}) => {
  const state = await mockApi(page)
  try {
    await page.goto("/playback")
    const sidebar = page.getByRole("complementary", { name: "设备通道" })
    const selected = sidebar.getByRole("button", {
      name: "摄像头 1",
      exact: true,
    })
    await expect(selected).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    expect(state.posts).toBe(0)
    await page.getByRole("button", { name: "播放", exact: true }).click()
    await expect(page.locator("video")).toHaveCount(1)
    await page.locator("video").evaluate((element) => {
      element.dataset.sessionMarker = "original"
    })

    const queryCount = state.queries.length
    await page.getByRole("button", { name: "收起通道", exact: true }).click()
    const expand = page.getByRole("button", { name: "展开通道", exact: true })
    await expect(expand).toBeFocused()
    await expect(page.locator("#playback-channels")).toHaveAttribute(
      "inert",
      ""
    )
    await expect(page.locator("video")).toHaveAttribute(
      "data-session-marker",
      "original"
    )
    await expand.click()
    await selected.click()
    await expect(page.locator("video")).toHaveAttribute(
      "data-session-marker",
      "original"
    )
    const channelRequests = state.channelRequests
    state.channels[0].name = "更新后的摄像头"
    await sidebar.getByRole("button", { name: "刷新通道" }).click()
    await expect(
      sidebar.getByRole("button", { name: "更新后的摄像头", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    expect(state.channelRequests).toBe(channelRequests + 1)
    expect(state.queries).toHaveLength(queryCount)
    await expect(page.locator("video")).toHaveAttribute(
      "data-session-marker",
      "original"
    )
    expect(state.deletes).toBe(0)

    const next = sidebar.getByRole("button", { name: "摄像头 2", exact: true })
    await next.focus()
    await page.keyboard.press("Enter")
    await expect(next).toHaveAttribute("aria-pressed", "true")
    await expect(page).toHaveURL(/track=201&date=2026-10-25/)
    await expect.poll(() => state.deletes).toBe(1)
    await expect(page.locator("video")).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "播放", exact: true })
    ).toBeVisible()
    expect(state.posts).toBe(1)
    expect(state.unexpected).toEqual([])
  } finally {
    state.releasePlaylist()
  }
})

test("playback sidebar shows channel loading, authentication failure, empty results and refresh recovery", async ({
  page,
}) => {
  const state = await mockApi(page, true)
  try {
    await page.goto("/playback")
    const sidebar = page.getByRole("complementary", { name: "设备通道" })
    await expect(
      sidebar.getByRole("status", { name: "正在读取通道" })
    ).toBeVisible()
    expect(state.queries).toHaveLength(0)
    state.channelError = true
    state.releaseChannels()
    await expect(sidebar.getByText("暂时无法显示通道")).toBeVisible()
    await expect(
      page.getByText("设备认证失败。", { exact: true })
    ).toBeVisible()
    expect(state.queries).toHaveLength(0)
    state.channelError = false
    state.channels = []
    await sidebar.getByRole("button", { name: "刷新通道" }).click()
    await expect(sidebar.getByText("暂无通道", { exact: true })).toBeVisible()
    expect(state.queries).toHaveLength(0)
    state.channels = channels(1)
    await sidebar.getByRole("button", { name: "刷新通道" }).click()
    await expect(
      sidebar.getByRole("button", { name: "摄像头 1", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByText("1 个录像片段")).toBeVisible()
    expect(state.posts).toBe(0)
    expect(state.unexpected).toEqual([])
  } finally {
    state.releaseChannels()
  }
})

test("the playback channel divider spans the workspace beyond the short channel list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await mockApi(page)
  await page.goto("/playback")
  await expect(page.getByText("1 个录像片段")).toBeVisible()
  const dimensions = await page
    .locator("#playback-channels")
    .evaluate((element) => {
      const workspace = element.parentElement!
      const frame = workspace.getBoundingClientRect()
      const column = element.getBoundingClientRect()
      const list = element
        .querySelector(".channel-list")!
        .getBoundingClientRect()
      return {
        borderWidth: getComputedStyle(element).borderRightWidth,
        topGap: column.top - frame.top - workspace.clientTop,
        bottomGap: frame.bottom - workspace.clientTop - column.bottom,
        extraHeight: column.height - list.height,
      }
    })
  expect(dimensions.borderWidth).toBe("1px")
  expect(Math.abs(dimensions.topGap)).toBeLessThan(1)
  expect(Math.abs(dimensions.bottomGap)).toBeLessThan(1)
  expect(dimensions.extraHeight).toBeGreaterThan(100)
  await page.screenshot({
    path: test.info().outputPath("playback-full-height-divider.png"),
  })
})

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
  { width: 375, height: 320 },
]) {
  test(`playback sidebar scrolls 64 channels independently at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const state = await mockApi(page)
    state.channels = channels(64)
    await page.goto("/playback")
    const sidebar = page.getByRole("complementary", { name: "设备通道" })
    await expect(sidebar.getByRole("button", { name: /^摄像头 / })).toHaveCount(
      64
    )
    const scroll = sidebar.locator(
      viewport.width > 767
        ? ".channel-sidebar-viewport"
        : ".channel-list-viewport"
    )
    expect(
      await scroll.evaluate(
        (element) => element.scrollHeight > element.clientHeight
      )
    ).toBe(true)
    const last = sidebar.getByRole("button", { name: "摄像头 64", exact: true })
    await last.focus()
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0)
    await expect(last).toBeInViewport()
    await page.keyboard.press("Enter")
    await expect(last).toHaveAttribute("aria-pressed", "true")
    await expect
      .poll(() => new URL(page.url()).searchParams.get("track"))
      .toBe("6401")
    expect(
      await page
        .locator(".app-scroll-viewport")
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    expect(state.posts).toBe(0)
    expect(state.unexpected).toEqual([])
    expect(errors).toEqual([])

    const results = page.getByRole("region", { name: "录像查询结果" })
    const initialWidth = await results.evaluate(
      (element) => element.clientWidth
    )
    await page.getByRole("button", { name: "收起通道", exact: true }).click()
    const expand = page.getByRole("button", { name: "展开通道", exact: true })
    await expect(expand).toHaveAttribute("aria-expanded", "false")
    await expect(expand).toHaveAttribute("aria-controls", "playback-channels")
    await expect(expand).toBeFocused()
    await expect(sidebar).toHaveCount(0)
    await expect
      .poll(() =>
        page.locator("#playback-channels").evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return innerWidth > 767 ? bounds.width : bounds.height
        })
      )
      .toBeLessThan(1)
    if (viewport.width > 767)
      expect(
        await results.evaluate((element) => element.clientWidth)
      ).toBeGreaterThan(initialWidth)
    await page.keyboard.press("Tab")
    await expect(
      page.getByRole("button", { name: "日期", exact: true })
    ).toBeFocused()
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sidebar"))
      .toBe("false")
    await page.reload()
    await expect(expand).toBeVisible()
    await expect(sidebar).toHaveCount(0)
    await expand.click()
    await expect(last).toHaveAttribute("aria-pressed", "true")
    await expect
      .poll(() => new URL(page.url()).searchParams.has("sidebar"))
      .toBe(false)
    expect(state.posts).toBe(0)
  })
}
