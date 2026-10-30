import { readFileSync } from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { splitFragmentedMp4 } from "../../server/mp4"

// Only synthetic pixels and mocked APIs are used in this suite.
const media = splitFragmentedMp4(
  readFileSync(new URL("../../fixtures/synthetic-preview.mp4", import.meta.url))
)
const segmentId = "d".repeat(32)
const dayStart = "2026-10-24T16:00:00.000Z"
const fileStart = "2026-10-24T15:59:00.000Z"
const fileEnd = "2026-10-24T17:00:00.000Z"
const atSecond = (second: number) =>
  new Date(Date.parse(dayStart) + second * 1000).toISOString()
const sessionId = (number: number) =>
  `55555555-5555-4555-8555-${String(number).padStart(12, "0")}`

async function mockServerSeekPlayback(
  page: Page,
  options: {
    missingFileDuration?: boolean
    leadSeconds?: number
    failedCreate?: number
    failedDelete?: boolean
    complete?: boolean
  } = {}
) {
  const posts: {
    at?: string
    track: string
    date: string
    segmentId: string
  }[] = []
  const events: string[] = []
  const failedPosts: string[] = []
  const createGates = new Map<number, Promise<void>>()
  let deleteGate: Promise<void> | undefined
  const holdCreate = (number: number) => {
    let release!: () => void
    createGates.set(
      number,
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    return release
  }
  const holdDelete = () => {
    let release!: () => void
    deleteGate = new Promise<void>((resolve) => {
      release = resolve
    })
    return () => {
      deleteGate = undefined
      release()
    }
  }
  page.on("requestfailed", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/streams/playback")
    )
      failedPosts.push(request.url())
  })
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-25",
        channels: [
          {
            id: "101",
            name: "SHTTP 合成通道",
            configuredEnabled: true,
          },
        ],
      },
    })
  )
  await page.route("**/api/recordings?**", (route) => {
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
        range: { startAt: dayStart, endAt: "2026-10-25T16:00:00.000Z" },
        segments: [segment],
        coverage: [segment],
        gaps: [],
        warnings: [],
      },
    })
  })
  await page.route("**/api/streams/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    if (request.method() === "POST") {
      const input = request.postDataJSON()
      const number = posts.push(input)
      events.push(`post:${number}`)
      await createGates.get(number)
      if (number === options.failedCreate)
        return route
          .fulfill({
            status: 502,
            json: {
              error: {
                code: "MEDIA_REMUX_FAILED",
                message: "所选时间的录像读取失败，请重试。",
              },
            },
          })
          .catch(() => {})
      const mediaStartAt = new Date(
        Date.parse(input.at ?? dayStart) - (options.leadSeconds ?? 0) * 1000
      ).toISOString()
      return route
        .fulfill({
          status: 201,
          json: {
            id: sessionId(number),
            playlistUrl: `/api/streams/${sessionId(number)}/index.m3u8`,
            fileRange: { startAt: fileStart, endAt: fileEnd },
            mediaStartAt,
            ...(!options.missingFileDuration && { fileDurationSeconds: 3660 }),
            source: "shttp",
            durationSeconds: 3,
            totalDurationSeconds: 3,
            startOffsetSeconds: options.leadSeconds ?? 0,
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            mode: "stream-copy",
            codec: "h264",
          },
        })
        .catch(() => {})
    }
    if (request.method() === "DELETE") {
      events.push(`delete:start:${path.split("/").at(-1)}`)
      await deleteGate
      events.push(`delete:end:${path.split("/").at(-1)}`)
      if (options.failedDelete)
        return route.fulfill({ status: 503 }).catch(() => {})
      return route.fulfill({ status: 204 }).catch(() => {})
    }
    if (path.endsWith("/status"))
      return route.fulfill({
        json: { complete: options.complete ?? false, durationSeconds: 3 },
      })
    if (path.endsWith("/audio"))
      return route.fulfill({
        json: { status: "unsupported", videoStartSeconds: 0, chunks: [] },
      })
    if (path.endsWith("index.m3u8"))
      return route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3.000000,\n0.m4s\n#EXT-X-ENDLIST\n',
      })
    return route.fulfill({
      contentType: path.endsWith("init.mp4")
        ? "video/mp4"
        : "video/iso.segment",
      body: path.endsWith("init.mp4") ? media.init : media.media,
    })
  })
  await page.goto("/playback?track=101&date=2026-10-25")
  await expect(page.getByRole("slider", { name: "回放时间轴" })).toBeVisible()
  return { posts, events, failedPosts, holdCreate, holdDelete }
}

async function pauseVideo(page: Page) {
  const video = page.locator("video")
  await expect(video).toHaveCount(1)
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
    .toBeGreaterThan(2)
  await video.evaluate((element: HTMLVideoElement) => element.pause())
  return video
}

async function restartPlayback(page: Page) {
  await page.getByRole("button", { name: "更多播放操作", exact: true }).click()
  await page
    .getByRole("button", { name: "从所选起点播放", exact: true })
    .click()
}

test.describe("SHTTP server-side seek", () => {
  test("stays idle on links, sends the selected instant and preserves full-file export coordinates", async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const mock = await mockServerSeekPlayback(page, {
      leadSeconds: 0.5,
    })
    expect(mock.posts).toEqual([])
    await page.getByRole("slider", { name: "回放时间轴" }).fill("1200")
    const video = await pauseVideo(page)
    expect(mock.posts[0]).toMatchObject({
      at: atSecond(1200),
      track: "101",
      date: "2026-10-25",
      segmentId,
    })
    await video.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 1
      element.pause()
    })
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.seeking)
      )
      .toBe(false)
    await expect(page.getByLabel("当前回放时间")).toHaveText("00:20:00")
    await page.getByRole("button", { name: "下载片段", exact: true }).click()
    await page.getByRole("button", { name: "将当前位置设为起点" }).click()
    await expect(page.getByLabel("片段起点")).toHaveValue("00:21:00")
    await page.getByLabel("片段终点").fill("00:21:30")
    await expect(
      page.getByRole("slider", { name: "下载选区" }).first()
    ).toHaveAttribute("max", "3660")
    await page.getByRole("button", { name: "关闭对话框", exact: true }).click()
    await page.getByRole("button", { name: "关闭回放", exact: true }).click()
    expect(errors).toEqual([])
  })

  test("a seek window duration is not exposed as the complete recording duration", async ({
    page,
  }) => {
    await mockServerSeekPlayback(page, { missingFileDuration: true })
    await page.getByRole("slider", { name: "回放时间轴" }).fill("1200")
    await pauseVideo(page)
    await page.getByRole("button", { name: "下载片段", exact: true }).click()
    await expect(page.getByRole("slider", { name: "下载选区" })).toHaveCount(0)
    await page.getByRole("button", { name: "关闭对话框", exact: true }).click()
    await page.getByRole("button", { name: "关闭回放", exact: true }).click()
  })

  test("same-file near-tail targets await DELETE, use only the latest target and retain preferences", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page)
    const timeline = page.getByRole("slider", { name: "回放时间轴" })
    await timeline.fill("1200")
    const original = await pauseVideo(page)
    await expect(page.getByRole("switch", { name: "声音" })).not.toBeChecked()
    await original.evaluate((element) => {
      element.dataset.oldSession = "yes"
    })
    await page.getByRole("button", { name: "播放倍速", exact: true }).click()
    await page.getByRole("button", { name: "2×", exact: true }).click()
    const release = mock.holdDelete()
    try {
      await timeline.fill("3590")
      await expect(page.locator("video")).toHaveCount(0)
      await expect
        .poll(
          () =>
            mock.events.filter((event) => event.startsWith("delete:start:"))
              .length
        )
        .toBe(1)
      await timeline.fill("3592")
      expect(mock.posts).toHaveLength(1)
      await expect(
        page.getByRole("button", { name: "取消准备", exact: true })
      ).toBeEnabled()
      release()
      await expect.poll(() => mock.posts.length).toBe(2)
      const current = await pauseVideo(page)
      expect(mock.posts[1].at).toBe(atSecond(3592))
      expect(mock.events.indexOf(`delete:end:${sessionId(1)}`)).toBeLessThan(
        mock.events.indexOf("post:2")
      )
      await expect(current).not.toHaveAttribute("data-old-session", "yes")
      await expect
        .poll(() =>
          current.evaluate((element: HTMLVideoElement) => element.playbackRate)
        )
        .toBe(2)
      await expect(page.getByRole("switch", { name: "声音" })).not.toBeChecked()
      await expect(page.getByLabel("当前回放时间")).toHaveText(/^00:59:5[23]$/)
      await page.getByRole("button", { name: "关闭回放", exact: true }).click()
    } finally {
      release()
    }
  })

  test("a newer target aborts pending preparation and an old response cannot replace it", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page)
    const release = mock.holdCreate(1)
    const timeline = page.getByRole("slider", { name: "回放时间轴" })
    try {
      await timeline.fill("1200")
      await expect.poll(() => mock.posts.length).toBe(1)
      await timeline.fill("1210")
      await expect.poll(() => mock.posts.length).toBe(2)
      await expect.poll(() => mock.failedPosts.length).toBe(1)
      const video = await pauseVideo(page)
      expect(mock.posts[1].at).toBe(atSecond(1210))
      await video.evaluate((element) => {
        element.dataset.latestSession = "yes"
      })
      release()
      await expect(page.getByLabel("当前回放时间")).toHaveText(/^00:20:1[0-2]$/)
      await expect(video).toHaveAttribute("data-latest-session", "yes")
      expect(mock.posts).toHaveLength(2)
      await page.getByRole("button", { name: "关闭回放", exact: true }).click()
    } finally {
      release()
    }
  })

  test("closing a target queued behind DELETE never resurrects the player", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page)
    const timeline = page.getByRole("slider", { name: "回放时间轴" })
    await timeline.fill("1200")
    await pauseVideo(page)
    const release = mock.holdDelete()
    try {
      await timeline.fill("1201")
      await expect
        .poll(
          () =>
            mock.events.filter((event) => event.startsWith("delete:start:"))
              .length
        )
        .toBe(1)
      await page.getByRole("button", { name: "取消准备", exact: true }).click()
      release()
      await expect
        .poll(
          () =>
            mock.events.filter((event) => event.startsWith("delete:end:"))
              .length
        )
        .toBe(1)
      await expect(page.locator("video")).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "播放", exact: true })
      ).toBeEnabled()
      expect(mock.posts).toHaveLength(1)
    } finally {
      release()
    }
  })

  test("cancelling pending preparation rejects a late response without reopening", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page)
    const release = mock.holdCreate(1)
    try {
      await page.getByRole("slider", { name: "回放时间轴" }).fill("1200")
      await expect.poll(() => mock.posts.length).toBe(1)
      await page.getByRole("button", { name: "取消准备", exact: true }).click()
      await expect.poll(() => mock.failedPosts.length).toBe(1)
      release()
      await expect(page.locator("video")).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "播放", exact: true })
      ).toBeEnabled()
      expect(mock.posts).toHaveLength(1)
    } finally {
      release()
    }
  })

  test("a failed target does not reuse old media or retry until explicitly requested", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page, {
      failedCreate: 2,
    })
    const timeline = page.getByRole("slider", { name: "回放时间轴" })
    await timeline.fill("1200")
    await pauseVideo(page)
    await timeline.fill("3592")
    await expect(page.locator(".stream-player [role=alert]")).toHaveText(
      "所选时间的录像读取失败，请重试。"
    )
    await expect(page.locator("video")).toHaveCount(0)
    expect(mock.posts).toHaveLength(2)
    expect(mock.events.indexOf(`delete:end:${sessionId(1)}`)).toBeLessThan(
      mock.events.indexOf("post:2")
    )
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await pauseVideo(page)
    expect(mock.posts).toHaveLength(3)
    expect(mock.posts[2].at).toBe(atSecond(3592))
    await page.getByRole("button", { name: "关闭回放", exact: true }).click()
  })

  test("failure to release the previous session never starts another target", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page, {
      failedDelete: true,
    })
    const timeline = page.getByRole("slider", { name: "回放时间轴" })
    await timeline.fill("1200")
    await pauseVideo(page)
    await timeline.fill("3592")
    await expect(page.locator(".stream-player [role=alert]")).toHaveText(
      "无法关闭上一段录像，请重试。"
    )
    await expect(page.locator("video")).toHaveCount(0)
    expect(mock.posts).toHaveLength(1)
  })

  test("an explicit restart awaits DELETE and reopens only the latest target", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page)
    const timeline = page.getByRole("slider", { name: "回放时间轴" })
    await timeline.fill("1200")
    await pauseVideo(page)
    const release = mock.holdDelete()
    try {
      await restartPlayback(page)
      await expect(page.locator("video")).toHaveCount(0)
      await expect
        .poll(
          () =>
            mock.events.filter((event) => event.startsWith("delete:start:"))
              .length
        )
        .toBe(1)
      expect(mock.posts).toHaveLength(1)
      await timeline.fill("1210")
      expect(mock.posts).toHaveLength(1)
      release()
      await expect.poll(() => mock.posts.length).toBe(2)
      await pauseVideo(page)
      expect(mock.posts[1].at).toBe(atSecond(1210))
      expect(mock.events.indexOf(`delete:end:${sessionId(1)}`)).toBeLessThan(
        mock.events.indexOf("post:2")
      )
      await page.getByRole("button", { name: "关闭回放", exact: true }).click()
    } finally {
      release()
    }
  })

  test("an explicit restart fails closed when DELETE cannot be confirmed", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page, { failedDelete: true })
    await page.getByRole("slider", { name: "回放时间轴" }).fill("1200")
    await pauseVideo(page)
    await restartPlayback(page)
    await expect(page.locator(".stream-player [role=alert]")).toHaveText(
      "无法关闭上一段录像，请重试。"
    )
    await expect(page.locator("video")).toHaveCount(0)
    expect(mock.posts).toHaveLength(1)
  })

  test("cancelling an explicit restart during DELETE never reopens playback", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page)
    await page.getByRole("slider", { name: "回放时间轴" }).fill("1200")
    await pauseVideo(page)
    const release = mock.holdDelete()
    try {
      await restartPlayback(page)
      await expect
        .poll(
          () =>
            mock.events.filter((event) => event.startsWith("delete:start:"))
              .length
        )
        .toBe(1)
      await page.getByRole("button", { name: "取消准备", exact: true }).click()
      release()
      await expect
        .poll(
          () =>
            mock.events.filter((event) => event.startsWith("delete:end:"))
              .length
        )
        .toBe(1)
      await expect(page.locator("video")).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "播放", exact: true })
      ).toBeEnabled()
      expect(mock.posts).toHaveLength(1)
    } finally {
      release()
    }
  })

  test("an explicit restart wins over an already releasing automatic handoff", async ({
    page,
  }) => {
    const mock = await mockServerSeekPlayback(page, { complete: true })
    await page.getByRole("slider", { name: "回放时间轴" }).fill("1200")
    const original = await pauseVideo(page)
    const release = mock.holdDelete()
    try {
      await original.evaluate((element: HTMLVideoElement) => {
        Object.defineProperty(element, "ended", {
          configurable: true,
          value: true,
        })
        element.dispatchEvent(new Event("ended", { bubbles: true }))
      })
      await expect
        .poll(
          () =>
            mock.events.filter((event) => event.startsWith("delete:start:"))
              .length
        )
        .toBe(1)
      await restartPlayback(page)
      await expect(page.locator("video")).toHaveCount(0)
      expect(mock.posts).toHaveLength(1)
      release()
      await expect.poll(() => mock.posts.length).toBe(2)
      await pauseVideo(page)
      expect(mock.posts[1].at).toBe(atSecond(1200))
      expect(
        mock.events.filter((event) => event.startsWith("delete:start:")).length
      ).toBe(1)
      expect(mock.events.indexOf(`delete:end:${sessionId(1)}`)).toBeLessThan(
        mock.events.indexOf("post:2")
      )
      await page.getByRole("button", { name: "关闭回放", exact: true }).click()
    } finally {
      release()
    }
  })
})
