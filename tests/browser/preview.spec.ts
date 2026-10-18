import { readFileSync } from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { splitFragmentedMp4 } from "../../server/mp4"
const mediaByCodec = {
  h264: splitFragmentedMp4(
    readFileSync(
      new URL("../../fixtures/synthetic-preview.mp4", import.meta.url)
    )
  ),
  hevc: splitFragmentedMp4(
    readFileSync(
      new URL("../../fixtures/synthetic-preview-hevc.mp4", import.meta.url)
    )
  ),
}

const id = "11111111-1111-4111-8111-111111111111",
  segmentId = "a".repeat(32)
async function mockQueries(page: Page) {
  await page.route("**/api/device", (route) =>
    route.fulfill({ json: { model: "TEST-NVR", firmware: "TEST" } })
  )
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-17",
        channels: [{ id: "101", name: "轨道 101", configuredEnabled: false }],
      },
    })
  )
  const range = {
      startAt: "2026-10-16T16:00:00Z",
      endAt: "2026-10-17T16:00:00Z",
    },
    segment = {
      id: segmentId,
      startAt: range.startAt,
      endAt: "2026-10-16T17:00:00Z",
      codec: "H.264-BP",
    }
  await page.route("**/api/recordings?**", (route) =>
    route.fulfill({
      json: {
        trackId: "101",
        date: "2026-10-17",
        timeZone: "Asia/Shanghai",
        range,
        segments: [segment],
        coverage: [segment],
        gaps: [],
        warnings: [],
      },
    })
  )
  await page.goto("/playback")
  await page.locator(".timeline-segment").first().click()
}
async function playAndSeek(page: Page, target: number) {
  const video = page.locator("video")
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), {
      timeout: 15000,
    })
    .toBeGreaterThanOrEqual(3)
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true
    await v.play()
  })
  await expect
    .poll(() =>
      video.evaluate(
        (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames
      )
    )
    .toBeGreaterThan(3)
  await video.evaluate((v: HTMLVideoElement) => v.pause())
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  await video.evaluate((v: HTMLVideoElement, time) => {
    v.currentTime = time
  }, target)
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking))
    .toBe(false)
  expect(
    await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  ).toBeCloseTo(target, 0)
  await video.evaluate(async (v: HTMLVideoElement) => {
    await v.play()
  })
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(target)
  await video.evaluate((v: HTMLVideoElement) => v.pause())
}
for (const codec of ["h264", "hevc"] as const) {
  test(`synthetic ${codec} HLS decodes in browser, seeks and releases on close/switch`, async ({
    page,
  }) => {
    const media = mediaByCodec[codec]
    const deleted: string[] = [],
      bodies: unknown[] = []
    await page.route("**/api/streams/**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname
      if (req.method() === "POST") {
        bodies.push(req.postDataJSON())
        return route.fulfill({
          status: 201,
          json: {
            id,
            playlistUrl: `/api/streams/${id}/index.m3u8`,
            durationSeconds: 3,
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            mode: "stream-copy",
            codec,
          },
        })
      }
      if (req.method() === "DELETE") {
        deleted.push(path)
        return route.fulfill({ status: 204 })
      }
      if (path.endsWith("index.m3u8"))
        return route.fulfill({
          contentType: "application/vnd.apple.mpegurl",
          body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3.000000,\nsegment.m4s\n#EXT-X-ENDLIST\n',
        })
      return route.fulfill({
        contentType: path.endsWith("init.mp4")
          ? "video/mp4"
          : "video/iso.segment",
        body: path.endsWith("init.mp4") ? media.init : media.media,
      })
    })
    await mockQueries(page)
    await page.getByRole("button", { name: "播放文件开头" }).click()
    await expect(
      page.getByText(
        `实际编码：${codec === "hevc" ? "H.265 / HEVC" : "H.264 / AVC"}，由本机浏览器解码。`
      )
    ).toBeVisible()
    await playAndSeek(page, 1)
    await page.setViewportSize({ width: 375, height: 812 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    await page.getByRole("button", { name: "关闭预览" }).click()
    await expect(page.locator("video")).toHaveCount(0)
    await expect.poll(() => deleted.length).toBe(1)
    expect(bodies).toEqual([{ track: "101", date: "2026-10-17", segmentId }])
    await page.getByRole("button", { name: "播放文件开头" }).click()
    await expect(page.locator("video")).toHaveCount(1)
    await page.getByLabel("设备日期").fill("2026-10-16")
    await expect.poll(() => deleted.length).toBe(2)
  })
}
test("preview failures remain retryable and pending preparation can cancel", async ({
  page,
}) => {
  let attempt = 0
  await page.route("**/api/streams/playback", async (route) => {
    attempt++
    if (attempt === 1)
      return route.fulfill({
        status: 502,
        json: {
          error: {
            code: "MEDIA_REMUX_FAILED",
            message: "读取录像中断，请重试。",
          },
        },
      })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route
      .fulfill({
        status: 503,
        json: { error: { code: "MEDIA_CANCELLED", message: "已取消" } },
      })
      .catch(() => {})
  })
  await mockQueries(page)
  await page.getByRole("button", { name: "播放文件开头" }).click()
  await expect(page.getByText("读取录像中断，请重试。")).toBeVisible()
  await page.getByRole("button", { name: "播放文件开头" }).click()
  await expect(page.getByText("正在准备预览，请稍候…")).toBeVisible()
  await page.getByRole("button", { name: "取消准备" }).click()
  await expect(page.getByRole("button", { name: "播放文件开头" })).toBeEnabled()
  await expect(page.locator("video")).toHaveCount(0)
})
test("real LAN preview: browser decoding, pause/seek and repeated cleanup", async ({
  page,
}) => {
  test.skip(process.env.NVR_INTEGRATION !== "1", "Explicit LAN opt-in required")
  test.setTimeout(90000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.name))
  await page.goto("/playback")
  await expect(page.getByLabel("设备日期")).toBeEnabled()
  await page.getByLabel("设备日期").fill("2026-10-17")
  await expect(page.getByText("13 个录像片段")).toBeVisible()
  await page.locator(".timeline-segment").first().click()
  for (let attempt = 0; attempt < 2; attempt++) {
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/streams/playback") &&
        response.request().method() === "POST"
    )
    await page.getByRole("button", { name: "播放文件开头" }).click()
    const response = await created
    expect(response.status()).toBe(201)
    const session = await response.json()
    expect(session.mode).toBe("stream-copy")
    expect(session.codec).toBe("hevc")
    expect(JSON.stringify(session)).not.toMatch(
      /rtsp:|playbackURI|Authorization/
    )
    await playAndSeek(page, 10)
    // Numeric decoder evidence only. Never capture private frames, traces or video.
    console.log(
      JSON.stringify({
        attempt: attempt + 1,
        codec: session.codec,
        duration: await page
          .locator("video")
          .evaluate((v: HTMLVideoElement) => v.duration),
        decodedFrames: await page
          .locator("video")
          .evaluate(
            (v: HTMLVideoElement) =>
              v.getVideoPlaybackQuality().totalVideoFrames
          ),
      })
    )
    const removed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/streams/${session.id}`) &&
        response.request().method() === "DELETE"
    )
    await page.getByRole("button", { name: "关闭预览" }).click()
    expect((await removed).status()).toBe(204)
    expect((await page.request.get(session.playlistUrl)).status()).toBe(404)
  }
  expect(errors).toEqual([])
})
