import { readFileSync } from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { splitFragmentedMp4 } from "../../server/mp4"

// Synthetic video only: no real device, wall-clock OCR, or private pixels.
const media = splitFragmentedMp4(
  readFileSync(new URL("../../fixtures/synthetic-preview.mp4", import.meta.url))
)
const sessionId = "44444444-4444-4444-8444-444444444444"
const segmentId = "c".repeat(32)
const dayStart = "2026-10-24T16:00:00.000Z"
const fileStart = "2026-10-24T15:59:59.000Z"
const fileEnd = "2026-10-24T16:00:02.000Z"

type MockOptions = {
  anchor?: boolean
  offset?: number
  available?: number
  complete?: boolean
  failFirst?: boolean
  holdPlaylist?: boolean
}
async function mockClockPlayback(page: Page, options: MockOptions = {}) {
  const state = {
    posts: 0,
    deletes: 0,
    available: options.available ?? 3,
    complete: options.complete ?? true,
    releasePlaylist: () => {},
  }
  let releasePlaylist!: () => void
  const playlistReady = options.holdPlaylist
    ? new Promise<void>((resolve) => {
        releasePlaylist = resolve
      })
    : Promise.resolve()
  state.releasePlaylist = () => releasePlaylist?.()
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-25",
        channels: [{ id: "101", name: "合成摄像头", configuredEnabled: true }],
      },
    })
  )
  await page.route("**/api/recordings?**", (route) => {
    const range = { startAt: dayStart, endAt: "2026-10-25T16:00:00.000Z" }
    const segment = {
      id: segmentId,
      startAt: dayStart,
      endAt: fileEnd,
      codec: "H.264",
    }
    return route.fulfill({
      json: {
        trackId: "101",
        date: "2026-10-25",
        timeZone: "Asia/Shanghai",
        range,
        segments: [segment],
        coverage: [segment],
        gaps: [],
        warnings: [],
      },
    })
  })
  await page.route("**/api/streams/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === "POST") {
      state.posts++
      if (options.failFirst && state.posts === 1) return route.abort("failed")
      return route.fulfill({
        status: 201,
        json: {
          id: sessionId,
          playlistUrl: `/api/streams/${sessionId}/index.m3u8`,
          ...(options.anchor !== false && {
            fileRange: { startAt: fileStart, endAt: fileEnd },
            startOffsetSeconds: options.offset ?? 1,
          }),
          estimatedDurationSeconds: 3,
          ...(state.complete && { totalDurationSeconds: state.available }),
          durationSeconds: state.available,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          mode: "stream-copy",
          codec: "h264",
        },
      })
    }
    if (request.method() === "DELETE") {
      state.deletes++
      return route.fulfill({ status: 204 })
    }
    if (path.endsWith("/status"))
      return route.fulfill({
        json: {
          complete: state.complete,
          durationSeconds: state.available,
          ...(state.complete && { totalDurationSeconds: state.available }),
        },
      })
    if (path.endsWith("/audio"))
      return route.fulfill({
        json: { status: "unsupported", videoStartSeconds: 0, chunks: [] },
      })
    if (path.endsWith("index.m3u8")) {
      await playlistReady
      return route
        .fulfill({
          contentType: "application/vnd.apple.mpegurl",
          body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3.000000,\n0.m4s\n#EXT-X-ENDLIST\n',
        })
        .catch(() => {})
    }
    return route.fulfill({
      contentType: path.endsWith("init.mp4")
        ? "video/mp4"
        : "video/iso.segment",
      body: path.endsWith("init.mp4") ? media.init : media.media,
    })
  })
  await page.goto("/playback?track=101&date=2026-10-25")
  return state
}

async function startAndPause(page: Page) {
  await page.getByRole("button", { name: "播放", exact: true }).click()
  const video = page.locator("video")
  await video.evaluate((element: HTMLVideoElement) => {
    element.loop = true
  })
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) =>
          element.getVideoPlaybackQuality().totalVideoFrames
      )
    )
    .toBeGreaterThan(3)
  await page.getByRole("button", { name: "暂停录像", exact: true }).click()
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.seeking))
    .toBe(false)
  return video
}

test("one daily timeline maps midnight to the full-file offset and shows actual playback time", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const state = await mockClockPlayback(page)
  const timeline = page.getByRole("slider", { name: "回放时间轴" })
  await expect(page.getByRole("slider")).toHaveCount(1)
  await expect(timeline).toHaveAttribute("min", "0")
  await expect(timeline).toHaveAttribute("max", "86399")
  await expect(timeline).toHaveAttribute("step", "1")
  await expect(page.locator(".selected-segment")).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "当日录像", exact: true })
  ).toHaveCount(0)
  expect(
    await page
      .locator(".recording-distribution")
      .evaluate((element) => !!element.closest(".playback-player"))
  ).toBe(true)
  await expect(page.getByText("当日覆盖", { exact: true })).toHaveCount(0)
  await expect(
    page.getByText("完整文件 · 设备时间", { exact: true })
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "定位时间" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^片段 1，/ })).toHaveCount(0)
  await expect(page.getByRole("switch", { name: "连续播放" })).toHaveCount(0)
  const idlePlay = page.getByRole("button", { name: "播放", exact: true })
  const idleBox = await page.locator(".playback-selection-empty").boundingBox()
  const idlePlayBox = await idlePlay.boundingBox()
  expect(idlePlayBox!.x + idlePlayBox!.width / 2).toBeCloseTo(
    idleBox!.x + idleBox!.width / 2,
    0
  )
  expect(idlePlayBox!.y + idlePlayBox!.height / 2).toBeCloseTo(
    idleBox!.y + idleBox!.height / 2,
    0
  )
  const video = await startAndPause(page)
  const initial = await video.evaluate(
    (element: HTMLVideoElement) => element.currentTime
  )
  expect(initial).toBeGreaterThanOrEqual(1)
  expect(initial).toBeLessThan(2)
  const clock = page.locator('time[aria-label="当前回放时间"]')
  await expect(clock).toHaveText("00:00:00")
  await expect(timeline).toHaveValue("0")
  await page.getByRole("button", { name: "播放录像", exact: true }).click()
  await expect(clock).toHaveText("00:00:01")
  await expect(timeline).toHaveValue("1")
  await page.getByRole("button", { name: "暂停录像", exact: true }).click()
  const paused = await video.evaluate(
    (element: HTMLVideoElement) => element.currentTime
  )
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime)
    )
    .toBeCloseTo(paused, 2)
  await page.getByRole("button", { name: "全屏", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true)
  await expect(page.getByRole("slider")).toHaveCount(1)
  expect(
    await timeline.evaluate((element) =>
      document.fullscreenElement?.contains(element)
    )
  ).toBe(true)
  await expect(clock).toHaveCount(1)
  await page.evaluate(() => document.exitFullscreen())
  expect(state.posts).toBe(1)
  expect(errors).toEqual([])
  await page.getByRole("button", { name: "关闭回放" }).click()
  await expect.poll(() => state.deletes).toBe(1)
})

test("the daily timeline previews a new second, commits a same-file seek and can return to midnight", async ({
  page,
}) => {
  const state = await mockClockPlayback(page)
  const video = await startAndPause(page)
  const timeline = page.getByRole("slider", { name: "回放时间轴" })
  const clock = page.locator('time[aria-label="当前回放时间"]')
  const paused = await video.evaluate(
    (element: HTMLVideoElement) => element.currentTime
  )
  await timeline.scrollIntoViewIfNeeded()
  const track = await page.locator('[data-slot="slider-track"]').boundingBox()
  expect(track).not.toBeNull()
  await page.mouse.move(
    track!.x + track!.width * 0.25,
    track!.y + track!.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    track!.x + track!.width * 0.5,
    track!.y + track!.height / 2,
    { steps: 5 }
  )
  const preview = Number(await timeline.inputValue())
  expect(preview).toBeGreaterThan(3600)
  const previewClock = new Date(Date.UTC(2026, 9, 25, 0, 0, preview))
    .toISOString()
    .slice(11, 19)
  await expect(clock).toHaveText(previewClock)
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.currentTime)
  ).toBeCloseTo(paused, 1)
  await page.mouse.up()
  // That daily position is outside this two-second fixture's coverage. A valid
  // same-file selection below then commits a real browser seek.
  expect(state.posts).toBe(1)
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "没有录像" })
  ).toBeVisible()
  await timeline.fill("1")
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime)
    )
    .toBeGreaterThanOrEqual(2)
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
    .toBe(false)
  await page.getByRole("button", { name: "暂停录像", exact: true }).click()
  await expect(clock).toHaveText("00:00:01")
  expect(state.posts).toBe(1)
  expect(state.deletes).toBe(0)
  await timeline.fill("0")
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime)
    )
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
    .toBe(false)
  await page.getByRole("button", { name: "暂停录像", exact: true }).click()
  await expect(clock).toHaveText("00:00:00")
  expect(state.posts).toBe(1)
  await page.getByRole("button", { name: "关闭回放" }).click()
})

test("committing the timeline starts an idle player and resumes paused playback even at the same second", async ({
  page,
}) => {
  const state = await mockClockPlayback(page)
  const timeline = page.getByRole("slider", { name: "回放时间轴" })
  expect(state.posts).toBe(0)
  await timeline.fill("1")
  const video = page.locator("video")
  await video.evaluate((element: HTMLVideoElement) => {
    element.loop = true
  })
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
    .toBe(false)
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) =>
          element.getVideoPlaybackQuality().totalVideoFrames
      )
    )
    .toBeGreaterThan(3)
  for (const target of ["0", undefined]) {
    await page.getByRole("button", { name: "暂停录像", exact: true }).click()
    const resume = page.getByRole("button", { name: "播放录像", exact: true })
    await expect(resume).toBeVisible()
    const frame = await page.locator(".playback-frame").boundingBox()
    const button = await resume.boundingBox()
    expect(button!.x + button!.width / 2).toBeCloseTo(
      frame!.x + frame!.width / 2,
      0
    )
    expect(button!.y + button!.height / 2).toBeCloseTo(
      frame!.y + frame!.height / 2,
      0
    )
    if (target !== undefined) await timeline.fill(target)
    else {
      // Commit the unchanged position with a real pointer gesture. Base UI's
      // input fill deliberately does not emit a commit for an unchanged value.
      await timeline.scrollIntoViewIfNeeded()
      const thumb = await page
        .locator('[data-slot="slider-thumb"]')
        .boundingBox()
      await page.mouse.move(
        thumb!.x + thumb!.width / 2,
        thumb!.y + thumb!.height / 2
      )
      await page.mouse.down()
      await page.mouse.up()
    }
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false)
    expect(state.posts).toBe(1)
  }
  await page.getByRole("button", { name: "关闭回放", exact: true }).click()
  await expect.poll(() => state.deletes).toBe(1)
  await timeline.fill("1")
  await expect.poll(() => state.posts).toBe(2)
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((element: HTMLVideoElement) => element.paused)
    )
    .toBe(false)
  await page.getByRole("button", { name: "关闭回放", exact: true }).click()
})

test("a pending start preserves the player frame and never reports its target as the actual position", async ({
  page,
}) => {
  const state = await mockClockPlayback(page, {
    available: 0.5,
    complete: false,
    holdPlaylist: true,
  })
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await expect(page.locator(".video-surface")).toBeVisible()
  await expect(
    page.getByText("正在定位所选时间", { exact: true })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "关闭回放" })).toBeEnabled()
  const surface = await page.locator(".video-surface").boundingBox()
  expect(surface!.height).toBeGreaterThan(200)
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((element: HTMLVideoElement) => element.paused)
    )
    .toBe(true)
  await page.getByRole("button", { name: "关闭回放" }).click()
  state.releasePlaylist()
  await expect(page.locator("video")).toHaveCount(0)
  await expect.poll(() => state.deletes).toBe(1)
})

test("an actual file shorter than the selected offset fails visibly and releases its session", async ({
  page,
}) => {
  const state = await mockClockPlayback(page, { available: 0.5 })
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await expect(
    page
      .locator('[data-sonner-toast][data-type="error"]')
      .filter({ hasText: /超出.*范围/ })
  ).toBeVisible()
  await expect(page.locator("video")).toHaveCount(0)
  await expect.poll(() => state.deletes).toBe(1)
  await expect(
    page.getByRole("button", { name: "重试", exact: true })
  ).toBeEnabled()
})

test("an unconfirmed file clock refuses a selected absolute time instead of playing from the file head", async ({
  page,
}) => {
  const state = await mockClockPlayback(page, { anchor: false })
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await expect(
    page
      .locator('[data-sonner-toast][data-type="error"]')
      .filter({ hasText: /时间.*确认|无法.*时间/ })
  ).toBeVisible()
  await expect(page.locator("video")).toHaveCount(0)

  await expect.poll(() => state.deletes).toBe(1)
})

test("a network failure leaves a usable retry which can load the same selected time", async ({
  page,
}) => {
  const state = await mockClockPlayback(page, { failFirst: true })
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]')
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "重试", exact: true })
  ).toBeEnabled()
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate(
          (element: HTMLVideoElement) =>
            element.getVideoPlaybackQuality().totalVideoFrames
        )
    )
    .toBeGreaterThan(3)
  expect(state.posts).toBe(2)
  await page.getByRole("button", { name: "关闭回放" }).click()
  await expect.poll(() => state.deletes).toBe(1)
})
