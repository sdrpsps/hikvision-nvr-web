import { readFileSync } from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { selectOption } from "./controls"
import { splitFragmentedMp4 } from "../../server/mp4"

async function channels(page: Page) {
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-17",
        channels: Array.from({ length: 16 }, (_, index) => ({
          id: String((index + 1) * 100 + 1),
          name: `摄像头 ${index + 1}`,
          configuredEnabled: false,
        })),
      },
    })
  )
}
for (const mobile of [false, true])
  test(`live wall is idle by default; all layouts and assignments ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 375, height: 812 })
    const mediaRequests: string[] = []
    page.on("request", (req) => {
      if (/\/api\/(streams|recordings)/.test(req.url()))
        mediaRequests.push(req.url())
    })
    await channels(page)
    await page.goto("/")
    await expect(
      page.getByRole("link", { name: "实时预览", exact: true })
    ).toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("button", { name: "全部停止" })).toBeDisabled()
    await expect(page.locator(".video-wall-cell")).toHaveCount(4)
    await expect(
      page.getByRole("button", { name: "4 路", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByLabel("窗口 1 通道", { exact: true })).toContainText(
      "摄像头 1"
    )
    for (const count of [1, 2, 4, 8, 16]) {
      await page
        .getByRole("button", { name: `${count} 路`, exact: true })
        .click()
      await expect(page.locator(".video-wall-cell")).toHaveCount(count)
      await expect(page.locator("video")).toHaveCount(0)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true)
      if (!mobile) {
        expect(
          await page.locator(".live-wall-viewport").evaluate((viewport) => ({
            verticalFits: viewport.scrollHeight <= viewport.clientHeight + 1,
            horizontalFits: viewport.scrollWidth <= viewport.clientWidth + 1,
          }))
        ).toEqual({ verticalFits: true, horizontalFits: true })
      }
    }
    await page.getByRole("button", { name: "选择窗口 2", exact: true }).click()
    await page.getByRole("button", { name: "摄像头 3", exact: true }).click()
    await expect(page.getByLabel("窗口 2 通道", { exact: true })).toContainText(
      "摄像头 3"
    )
    await selectOption(page, "窗口 2 通道", "摄像头 4")
    const collapse = page.getByRole("button", { name: "收起通道" })
    await collapse.focus()
    await collapse.press("Enter")
    await expect(
      page.getByRole("complementary", { name: "设备通道" })
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "展开通道" })
    ).toHaveAttribute("aria-expanded", "false")
    await selectOption(page, "窗口 2 通道", "摄像头 5")
    await expect(page.getByLabel("窗口 2 通道", { exact: true })).toContainText(
      "摄像头 5"
    )
    await page.getByRole("button", { name: "展开通道" }).click()
    await expect(
      page.getByRole("complementary", { name: "设备通道" })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "摄像头 5", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    if (mobile) {
      await page.setViewportSize({ width: 375, height: 1200 })
      await page.getByRole("button", { name: "1 路", exact: true }).click()
      await page.getByRole("button", { name: "收起通道" }).click()
      await expect
        .poll(() =>
          page.locator(".live-stage").evaluate((stage) => {
            const workspace = stage.parentElement!
            return Math.abs(
              stage.getBoundingClientRect().top -
                workspace.getBoundingClientRect().top -
                workspace.clientTop
            )
          })
        )
        .toBeLessThan(1)
    }
    expect(mediaRequests).toEqual([])
  })
for (const codec of ["h264", "hevc"] as const)
  test(`manual live ${codec} playback and cleanup on channel/layout/navigation`, async ({
    page,
  }) => {
    const media = splitFragmentedMp4(
      readFileSync(
        new URL(
          `../../fixtures/${codec === "hevc" ? "synthetic-preview-hevc.mp4" : "synthetic-preview.mp4"}`,
          import.meta.url
        )
      )
    )
    const deleted: string[] = [],
      bodies: unknown[] = []
    let count = 0
    await channels(page)
    await page.route("**/api/streams/**", (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname
      if (req.method() === "POST") {
        bodies.push(req.postDataJSON())
        const id = `11111111-1111-4111-8111-${String(++count).padStart(12, "0")}`
        return route.fulfill({
          status: 201,
          json: {
            id,
            playlistUrl: `/api/streams/${id}/index.m3u8`,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
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
          body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3,\n0.m4s\n#EXT-X-ENDLIST\n',
        })
      return route.fulfill({
        contentType: path.endsWith("init.mp4")
          ? "video/mp4"
          : "video/iso.segment",
        body: path.endsWith("init.mp4") ? media.init : media.media,
      })
    })
    await page.goto("/")
    const window1 = page.getByRole("region", { name: "窗口 1", exact: true })
    await window1.getByRole("button", { name: "开始预览" }).click()
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate(
            (v: HTMLVideoElement) =>
              v.getVideoPlaybackQuality().totalVideoFrames
          )
      )
      .toBeGreaterThan(3)
    expect(bodies).toEqual([{ track: "101" }])
    await expect(page.getByRole("button", { name: "全部停止" })).toBeEnabled()
    await page.getByRole("button", { name: "收起通道" }).click()
    await expect(window1.locator("video")).toHaveCount(1)
    expect(deleted).toEqual([])
    expect(bodies).toEqual([{ track: "101" }])
    await page.getByRole("button", { name: "展开通道" }).click()
    await selectOption(page, "窗口 1 通道", "摄像头 2")
    await expect.poll(() => deleted.length).toBe(1)
    await expect(page.locator("video")).toHaveCount(0)
    await page
      .getByRole("region", { name: "窗口 4", exact: true })
      .getByRole("button", { name: "开始预览" })
      .click()
    await expect(page.locator("video")).toHaveCount(1)
    await page.getByRole("button", { name: "2 路", exact: true }).click()
    await expect.poll(() => deleted.length).toBe(2)
    await window1.getByRole("button", { name: "开始预览" }).click()
    await expect(page.locator("video")).toHaveCount(1)
    await page.getByRole("button", { name: "全部停止" }).click()
    await expect.poll(() => deleted.length).toBe(3)
    await expect(page.locator("video")).toHaveCount(0)
    await window1.getByRole("button", { name: "开始预览" }).click()
    await expect(page.locator("video")).toHaveCount(1)
    await page.getByRole("link", { name: "录像回放" }).click()
    await expect.poll(() => deleted.length).toBe(4)
    await expect(page).toHaveURL(/\/playback$/)
  })
test("live start failure can retry and preparation can cancel", async ({
  page,
}) => {
  await channels(page)
  let attempt = 0
  let finishPreparation!: () => void
  const preparation = new Promise<void>((resolve) => {
    finishPreparation = resolve
  })
  await page.route("**/api/streams/live", async (route) => {
    attempt++
    if (attempt > 1) await preparation
    await route
      .fulfill({
        status: 502,
        json: { error: { code: "LIVE_TIMEOUT", message: "实时连接超时。" } },
      })
      .catch(() => {})
  })
  await page.goto("/")
  const first = page.getByRole("region", { name: "窗口 1", exact: true })
  await first.getByRole("button", { name: "开始预览" }).click()
  await expect(page.getByText("实时连接超时。")).toBeVisible()
  await expect(page.getByRole("button", { name: "全部停止" })).toBeDisabled()
  await first.getByRole("button", { name: "重试", exact: true }).click()
  await expect(first.getByRole("status")).toHaveText("正在准备预览，请稍候…")
  await expect(page.getByRole("button", { name: "全部停止" })).toBeEnabled()
  for (const width of [1440, 1280, 375]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const count of [4, 16]) {
      await page
        .getByRole("button", { name: `${count} 路`, exact: true })
        .click()
      const row = await first.locator(".preview-control-row").evaluate((el) => {
        const status = el
          .querySelector('[role="status"]')!
          .getBoundingClientRect()
        const button = el.querySelector("button")!.getBoundingClientRect()
        return {
          sameLine:
            Math.abs(
              status.y + status.height / 2 - button.y - button.height / 2
            ) < 1,
          ordered: status.right <= button.left,
          fits: el.scrollWidth <= el.clientWidth,
        }
      })
      expect(row).toEqual({ sameLine: true, ordered: true, fits: true })
      if (width === 1440 && count === 4)
        await first.screenshot({
          path: test.info().outputPath("preparing-inline.png"),
        })
    }
  }
  await first.getByRole("button", { name: "取消准备" }).click()
  finishPreparation()
  await expect(first.getByRole("button", { name: "开始预览" })).toBeEnabled()
  await expect(page.getByRole("button", { name: "全部停止" })).toBeDisabled()
  await expect(page.locator("video")).toHaveCount(0)
})
test("channel failure retries; empty channels disable playback", async ({
  page,
}) => {
  let retry = false
  await page.route("**/api/channels", (route) =>
    !retry
      ? route.fulfill({
          status: 502,
          json: {
            error: { code: "NVR_UNREACHABLE", message: "无法连接设备。" },
          },
        })
      : route.fulfill({
          json: {
            timeZone: "Asia/Shanghai",
            today: "2026-10-17",
            channels: [],
          },
        })
  )
  await page.goto("/")
  await expect(page.getByText("通道读取失败")).toBeVisible()
  retry = true
  await page.getByRole("button", { name: "刷新通道" }).click()
  await expect(page.getByText("暂无通道")).toBeVisible()
  for (const button of await page
    .getByRole("button", { name: "开始预览" })
    .all())
    await expect(button).toBeDisabled()
})

test("real LAN live preview decodes and releases its session", async ({
  page,
}) => {
  test.skip(
    process.env.NVR_INTEGRATION !== "1",
    "Explicit local integration opt-in required"
  )
  test.setTimeout(60000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.name))
  await page.goto("/")
  const first = page.getByRole("region", { name: "窗口 1", exact: true })
  await expect(first.getByRole("button", { name: "开始预览" })).toBeEnabled()
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/streams/live") &&
      response.request().method() === "POST"
  )
  await first.getByRole("button", { name: "开始预览" }).click()
  const response = await created
  expect(response.status()).toBe(201)
  const session = await response.json()
  expect(JSON.stringify(session)).not.toMatch(/rtsp:|playbackURI|Authorization/)
  const video = first.locator("video")
  await expect
    .poll(
      () =>
        video.evaluate(
          (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames
        ),
      { timeout: 25000 }
    )
    .toBeGreaterThan(3)
  const frames = await video.evaluate(
    (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames
  )
  await expect
    .poll(
      () =>
        video.evaluate(
          (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames
        ),
      { timeout: 10000 }
    )
    .toBeGreaterThan(frames + 10)
  console.log(
    JSON.stringify({
      liveCodec: session.codec,
      decodedFrames: await video.evaluate(
        (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames
      ),
    })
  )
  const removed = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/streams/${session.id}`) &&
      response.request().method() === "DELETE"
  )
  await first.getByRole("button", { name: "停止预览" }).click()
  expect((await removed).status()).toBe(204)
  expect((await page.request.get(session.playlistUrl)).status()).toBe(404)
  expect(errors).toEqual([])
})

for (const mobile of [false, true])
  test(`start all skips active/pending/unassigned windows and retries failures ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 375, height: 812 })
    await channels(page)
    const media = splitFragmentedMp4(
      readFileSync(
        new URL("../../fixtures/synthetic-preview.mp4", import.meta.url)
      )
    )
    const tracks: string[] = [],
      deleted: string[] = []
    let releasePending!: () => void
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve
    })
    let hold = true,
      failed = false,
      sequence = 0
    await page.route("**/api/streams/**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname
      if (req.method() === "POST") {
        const { track } = req.postDataJSON()
        tracks.push(track)
        if (track === "301" && !failed) {
          failed = true
          return route.fulfill({
            status: 502,
            json: {
              error: { code: "LIVE_TIMEOUT", message: "第三路连接超时。" },
            },
          })
        }
        if (track === "201" && hold) await pending
        const id = `22222222-2222-4222-8222-${String(++sequence).padStart(12, "0")}`
        await route
          .fulfill({
            status: 201,
            json: {
              id,
              playlistUrl: `/api/streams/${id}/index.m3u8`,
              expiresAt: new Date(Date.now() + 600000).toISOString(),
              mode: "stream-copy",
              codec: "h264",
            },
          })
          .catch(() => {})
        return
      }
      if (req.method() === "DELETE") {
        deleted.push(path)
        return route.fulfill({ status: 204 })
      }
      if (path.endsWith("index.m3u8"))
        return route.fulfill({
          contentType: "application/vnd.apple.mpegurl",
          body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3,\n0.m4s\n#EXT-X-ENDLIST\n',
        })
      return route.fulfill({
        contentType: path.endsWith("init.mp4")
          ? "video/mp4"
          : "video/iso.segment",
        body: path.endsWith("init.mp4") ? media.init : media.media,
      })
    })
    try {
      await page.goto("/")
      await selectOption(page, "窗口 4 通道", "选择通道")
      expect(tracks).toEqual([])
      const first = page.getByRole("region", { name: "窗口 1", exact: true })
      await first.getByRole("button", { name: "开始预览" }).click()
      await expect(first.locator("video")).toHaveCount(1)
      await page.getByRole("button", { name: "全部开始" }).click()
      await expect.poll(() => tracks.length).toBe(3)
      await expect(page.getByText("第三路连接超时。")).toBeVisible()
      await page.getByRole("button", { name: "全部开始" }).click()
      await expect.poll(() => tracks.length).toBe(4)
      await expect(page.locator("video")).toHaveCount(2)
      await page.getByRole("button", { name: "全部开始" }).click()
      expect(tracks[0]).toBe("101")
      expect(tracks.slice(1).sort()).toEqual(["201", "301", "301"])
      await page.getByRole("button", { name: "全部停止" }).click()
      await expect(page.locator("video")).toHaveCount(0)
      await expect.poll(() => deleted.length).toBe(2)
      hold = false
      releasePending()
      await page.getByRole("button", { name: "全部开始" }).click()
      await expect.poll(() => tracks.length).toBe(7)
      await expect(page.locator("video")).toHaveCount(3)
      await page.getByRole("button", { name: "8 路", exact: true }).click()
      await expect(page.locator(".video-wall-cell")).toHaveCount(8)
      expect(tracks).toHaveLength(7)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true)
      await page.getByRole("button", { name: "全部停止" }).click()
      await expect.poll(() => deleted.length).toBe(5)
    } finally {
      releasePending()
    }
  })

for (const codec of ["h264", "hevc"] as const)
  test(`live ${codec} selection never pauses; copied G711 plays locally and releases on mute/stop`, async ({
    page,
  }) => {
    await channels(page)
    const videoMedia = splitFragmentedMp4(
      readFileSync(
        new URL(
          `../../fixtures/${codec === "hevc" ? "synthetic-preview-hevc.mp4" : "synthetic-preview.mp4"}`,
          import.meta.url
        )
      )
    )
    const audioFile = readFileSync(
      new URL("../../fixtures/synthetic-g711-audio.mov", import.meta.url)
    )
    const { mp4Boxes } = await import("../../server/mp4")
    const { copiedAudio } = await import("../../server/live-audio")
    const top = mp4Boxes(audioFile),
      firstMoof = top.find((box) => box.type === "moof")!
    const audioInit = audioFile.subarray(0, firstMoof.start)
    const chunks = top
      .filter((box) => box.type === "moof")
      .map((moof, sequence) => {
        const mdat = top.find(
          (box) => box.type === "mdat" && box.start > moof.start
        )!
        const chunk = copiedAudio(
          audioInit,
          audioFile.subarray(moof.start, mdat.end)
        )
        return { ...chunk, sequence, data: chunk.data.toString("base64") }
      })
    await page.addInitScript(() => {
      const stats = { sources: 0, peak: 0, closed: 0 }
      Object.assign(window, { audioTestStats: stats })
      const originalStart = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args) {
        stats.sources++
        const data = this.buffer?.getChannelData(0)
        if (data)
          for (let i = 0; i < data.length; i++)
            stats.peak = Math.max(stats.peak, Math.abs(data[i]))
        return originalStart.apply(this, args)
      }
      const originalClose = AudioContext.prototype.close
      AudioContext.prototype.close = function () {
        stats.closed++
        return originalClose.call(this)
      }
    })
    let audioRequests = 0,
      posts = 0,
      deletes = 0
    await page.route("**/api/streams/**", (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        path = url.pathname
      if (req.method() === "POST") {
        const id = `33333333-3333-4333-8333-${String(++posts).padStart(12, "0")}`
        return route.fulfill({
          status: 201,
          json: {
            id,
            playlistUrl: `/api/streams/${id}/index.m3u8`,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            mode: "stream-copy",
            codec,
          },
        })
      }
      if (req.method() === "DELETE") {
        deletes++
        return route.fulfill({ status: 204 })
      }
      if (path.endsWith("/audio")) {
        audioRequests++
        const after = Number(url.searchParams.get("after") ?? -1)
        return route.fulfill({
          json: {
            status: "available",
            videoStartSeconds: 0,
            chunks: chunks.filter((chunk) => chunk.sequence > after),
          },
        })
      }
      if (path.endsWith("index.m3u8"))
        return route.fulfill({
          contentType: "application/vnd.apple.mpegurl",
          body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3,\n0.m4s\n#EXT-X-ENDLIST\n',
        })
      return route.fulfill({
        contentType: path.endsWith("init.mp4")
          ? "video/mp4"
          : "video/iso.segment",
        body: path.endsWith("init.mp4") ? videoMedia.init : videoMedia.media,
      })
    })
    await page.goto("/")
    const first = page.getByRole("region", { name: "窗口 1", exact: true })
    await first.getByRole("button", { name: "开始预览" }).click()
    const video = first.locator("video")
    // Loop only the artificial 3-second sample so selection/audio assertions have time.
    await video.evaluate((v: HTMLVideoElement) => {
      v.loop = true
    })
    await expect
      .poll(() =>
        video.evaluate(
          (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames
        )
      )
      .toBeGreaterThan(3)
    expect(await video.evaluate((v: HTMLVideoElement) => v.controls)).toBe(
      false
    )
    expect(audioRequests).toBe(0)
    await page.getByRole("button", { name: "选择窗口 2", exact: true }).click()
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
    await video.click()
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
    await first.getByRole("button", { name: "选择窗口 1", exact: true }).click()
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
    await expect(first.getByRole("switch", { name: "声音" })).not.toBeChecked()
    await expect(
      first.locator('.sound-control label[title="声音已静音"] svg')
    ).toBeVisible()
    await expect(first.getByText("实时预览中", { exact: true })).toHaveCount(0)
    await first.getByRole("switch", { name: "声音" }).click()
    await expect(first.getByRole("switch", { name: "声音" })).toBeChecked()
    await expect(
      first.locator('.sound-control label[title="声音已开启"] svg')
    ).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { audioTestStats: { sources: number } })
              .audioTestStats.sources
        )
      )
      .toBeGreaterThan(0)
    const stats = await page.evaluate(
      () =>
        (window as unknown as { audioTestStats: { peak: number } })
          .audioTestStats
    )
    expect(stats.peak).toBeGreaterThan(0.1)
    await video.click()
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
    expect(posts).toBe(1)
    expect(deletes).toBe(0)
    await first.getByRole("switch", { name: "声音" }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { audioTestStats: { closed: number } })
              .audioTestStats.closed
        )
      )
      .toBe(1)
    const stoppedRequests = audioRequests
    await page.waitForTimeout(650)
    expect(audioRequests).toBe(stoppedRequests)
    await expect(first.getByRole("switch", { name: "声音" })).not.toBeChecked()
    await expect(
      first.locator('.sound-control label[title="声音已静音"] svg')
    ).toBeVisible()
    for (const width of [1440, 1280, 375]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const count of [1, 2, 4, 8, 16]) {
        await page
          .getByRole("button", { name: `${count} 路`, exact: true })
          .click()
        const row = await first
          .locator(".live-video-controls")
          .evaluate((element) => {
            const left = element
              .querySelector(".live-controls-left")!
              .getBoundingClientRect()
            const right = element
              .querySelector(".preview-actions")!
              .getBoundingClientRect()
            const controls = Array.from(
              element.querySelectorAll(
                '[role="switch"],button[aria-label="全屏"],button[aria-label="更多播放操作"],button[aria-label="停止预览"]'
              )
            ).map((el) => {
              const r = el.getBoundingClientRect()
              return r.y + r.height / 2
            })
            return {
              ordered: left.right <= right.left,
              sameLine: Math.max(...controls) - Math.min(...controls) < 1,
              fits: element.scrollWidth <= element.clientWidth,
              pageFits: document.documentElement.scrollWidth <= innerWidth,
            }
          })
        expect(row).toEqual({
          ordered: true,
          sameLine: true,
          fits: true,
          pageFits: true,
        })
        if (
          codec === "h264" &&
          ((width === 1440 && count === 4) ||
            (width === 1280 && count === 16) ||
            (width === 375 && count === 4))
        )
          await first.screenshot({
            path: test
              .info()
              .outputPath(`inline-controls-${width}-${count}.png`),
          })
      }
    }
    await page.setViewportSize({ width: 800, height: 900 })
    await page.getByRole("button", { name: "16 路", exact: true }).click()
    await first
      .getByRole("button", { name: "更多播放操作", exact: true })
      .click()
    const restart = page.getByRole("button", { name: "重新连接", exact: true })
    await expect(restart).toBeVisible()
    expect(
      await restart.evaluate((button) => {
        const popup = button.closest('[data-slot="popover-content"]')!
        const bounds = popup.getBoundingClientRect()
        const points = [
          [bounds.left + 10, bounds.top + 10],
          [bounds.right - 10, bounds.top + 10],
          [bounds.left + 10, bounds.bottom - 10],
          [bounds.right - 10, bounds.bottom - 10],
        ]
        return points.every(([x, y]) =>
          popup.contains(document.elementFromPoint(x, y))
        )
      })
    ).toBe(true)
    await page.keyboard.press("Escape")
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole("button", { name: "4 路", exact: true }).click()
    await first.getByRole("button", { name: "全屏", exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            !!document.fullscreenElement?.classList.contains("video-surface")
        )
      )
      .toBe(true)
    await expect(first.getByRole("button", { name: "停止预览" })).toBeVisible()
    await page.evaluate(() => document.exitFullscreen())
    await first.getByRole("switch", { name: "声音" }).click()
    await expect(first.getByRole("switch", { name: "声音" })).toBeChecked()
    await first.getByRole("button", { name: "停止预览" }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { audioTestStats: { closed: number } })
              .audioTestStats.closed
        )
      )
      .toBe(2)
    await expect.poll(() => deletes).toBe(1)
  })
