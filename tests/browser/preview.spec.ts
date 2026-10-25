import { readFileSync } from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { selectDate } from "./controls"
import { splitFragmentedMp4, mp4Boxes } from "../../server/mp4"
import { copiedAudio } from "../../server/live-audio"
const audioFile = readFileSync(
  new URL("../../fixtures/synthetic-g711-audio.mov", import.meta.url)
)
const audioBoxes = mp4Boxes(audioFile)
const audioInit = audioFile.subarray(
  0,
  audioBoxes.find((box) => box.type === "moof")!.start
)
const audioChunks = audioBoxes
  .filter((box) => box.type === "moof")
  .map((moof, sequence) => {
    const mdat = audioBoxes.find(
      (box) => box.type === "mdat" && box.start > moof.start
    )!
    const chunk = copiedAudio(
      audioInit,
      audioFile.subarray(moof.start, mdat.end)
    )
    return { ...chunk, sequence, data: chunk.data.toString("base64") }
  })
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
async function mockQueries(
  page: Page,
  segments?: { id: string; startAt: string; endAt: string; codec: string }[]
) {
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
        segments: segments ?? [segment],
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
  await expect
    .poll(() =>
      video.evaluate(
        (v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames
      )
    )
    .toBeGreaterThan(3)
  await video.click()
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false)
  await page.getByRole("button", { name: "暂停录像", exact: true }).click()
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
  const slider = page.getByRole("slider", { name: "播放进度" })
  await expect
    .poll(async () => Number(await slider.getAttribute("max")), {
      timeout: 20000,
    })
    .toBeGreaterThan(target)
  await slider.fill(String(target))
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking))
    .toBe(false)
  expect(
    await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  ).toBeCloseTo(target, 0)
  await page.getByRole("button", { name: "播放录像", exact: true }).click()
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(target)
  await page.getByRole("button", { name: "暂停录像", exact: true }).click()
}
for (const codec of ["h264", "hevc"] as const) {
  test(`synthetic ${codec} HLS decodes in browser, seeks and releases on close/switch`, async ({
    page,
  }) => {
    const media = mediaByCodec[codec]
    const deleted: string[] = [],
      bodies: unknown[] = []
    const audioRequests: { after: number; at: number }[] = []
    await page.addInitScript(() => {
      const stats = { rates: [] as number[], closed: 0, peak: 0 }
      Object.assign(window, { playbackAudioStats: stats })
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args) {
        stats.rates.push(this.playbackRate.value)
        const samples = this.buffer?.getChannelData(0)
        if (samples)
          for (const sample of samples)
            stats.peak = Math.max(stats.peak, Math.abs(sample))
        return start.apply(this, args)
      }
      const close = AudioContext.prototype.close
      AudioContext.prototype.close = function () {
        stats.closed++
        return close.call(this)
      }
    })
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
      if (path.endsWith("/status"))
        return route.fulfill({ json: { complete: true, durationSeconds: 3 } })
      if (path.endsWith("/audio")) {
        const query = new URL(req.url()).searchParams
        const after = Number(query.get("after") ?? -1),
          at = Number(query.get("at") ?? 0)
        audioRequests.push({ after, at })
        return route.fulfill({
          json: {
            status: "available",
            videoStartSeconds: 0,
            chunks: audioChunks.filter(
              (chunk) =>
                chunk.sequence > after &&
                chunk.startSeconds + chunk.data.length > at
            ),
          },
        })
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
    const playerBox = await page.locator(".playback-player").boundingBox()
    const timelineBox = await page
      .locator(".recording-distribution")
      .boundingBox()
    expect(playerBox!.width).toBeCloseTo(timelineBox!.width, 0)
    expect(playerBox!.x).toBeCloseTo(timelineBox!.x, 0)
    const idle = await page.locator(".stream-idle").boundingBox()
    expect(idle!.width / idle!.height).toBeCloseTo(16 / 9, 2)
    await expect(page.getByText("画面未开启", { exact: true })).toBeVisible()
    expect(bodies).toEqual([])
    await page.getByRole("button", { name: "播放" }).click()
    await page.locator("video").evaluate((v: HTMLVideoElement) => {
      v.loop = true
    })
    await expect(
      page.getByText(/实际编码：|预览已就绪|文件起点与/)
    ).toHaveCount(0)
    await expect(page.locator("video")).not.toHaveAttribute("controls")
    await expect(page.getByRole("switch", { name: "声音" })).toBeVisible()
    await expect
      .poll(() =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState)
      )
      .toBeGreaterThanOrEqual(3)
    const picture = await page.locator("video").boundingBox()
    expect(picture!.width / picture!.height).toBeCloseTo(16 / 9, 2)
    expect(picture!.height).toBeCloseTo(idle!.height, 0)
    await page.getByRole("button", { name: "全屏", exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true)
    await expect(
      page.getByRole("button", { name: "暂停录像", exact: true })
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "关闭回放" })).toBeVisible()
    await expect(
      page.getByRole("button", { name: "从头播放", exact: true })
    ).toHaveCount(0)
    await page
      .getByRole("button", { name: "更多播放操作", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "从头播放", exact: true })
    ).toBeVisible()
    expect(
      await page
        .locator('[data-slot="popover-content"]')
        .evaluate((element) => document.fullscreenElement?.contains(element))
    ).toBe(true)
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "播放倍速" }).click()
    await page.getByRole("button", { name: "1.25×", exact: true }).click()
    await expect
      .poll(() =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.playbackRate)
      )
      .toBe(1.25)
    await page.getByRole("button", { name: "播放倍速" }).click()
    await page.getByRole("button", { name: "1×", exact: true }).click()
    await page.evaluate(() => document.exitFullscreen())
    await playAndSeek(page, 1)
    await page.getByRole("switch", { name: "声音" }).click()
    await page.getByRole("button", { name: "播放录像", exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { playbackAudioStats: { peak: number } })
              .playbackAudioStats.peak
        )
      )
      .toBeGreaterThan(0.1)
    await page.getByRole("button", { name: "播放倍速" }).click()
    await page.getByRole("button", { name: "2×", exact: true }).click()
    await expect
      .poll(() =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.playbackRate)
      )
      .toBe(2)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { playbackAudioStats: { rates: number[] } }
          ).playbackAudioStats.rates.includes(2)
        )
      )
      .toBe(true)
    await page.getByRole("button", { name: "播放倍速" }).click()
    await expect(page.getByLabel("自定义倍速")).toHaveCount(0)
    await page.getByRole("button", { name: "自定义…", exact: true }).click()
    await page.getByLabel("自定义倍速").fill("1.35")
    await page.getByRole("button", { name: "应用", exact: true }).click()
    await expect
      .poll(() =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.playbackRate)
      )
      .toBeCloseTo(1.35, 2)
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { playbackAudioStats: { rates: number[] } }
          ).playbackAudioStats.rates.some(
            (rate) => Math.abs(rate - 1.35) < 0.001
          )
        )
      )
      .toBe(true)
    await page.getByRole("button", { name: "暂停录像", exact: true }).click()
    await page.getByRole("slider", { name: "播放进度" }).fill("0.5")
    await expect
      .poll(
        () =>
          audioRequests.filter(
            (request) =>
              request.after === -1 && Math.abs(request.at - 0.5) < 0.1
          ).length
      )
      .toBeGreaterThan(0)
    await page.getByRole("button", { name: "全屏", exact: true }).click()
    await page.getByRole("button", { name: "播放倍速" }).click()
    await expect(page.getByLabel("自定义倍速")).toBeVisible()
    await page.getByLabel("自定义倍速").fill("0")
    await page.getByRole("button", { name: "应用", exact: true }).click()
    await expect(page.getByText("请输入 0.25–4 之间的倍速。")).toBeVisible()
    expect(
      await page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.playbackRate)
    ).toBeCloseTo(1.35, 2)
    await page.getByLabel("自定义倍速").fill("1")
    await page.getByRole("button", { name: "应用", exact: true }).click()
    await expect(page.locator('[data-slot="popover-content"]')).toBeHidden()
    await page.evaluate(() => document.exitFullscreen())
    await page.locator(".playback-player").screenshot({
      path: `/tmp/hikvision-playback-${codec}-desktop.png`,
    })
    await page.setViewportSize({ width: 375, height: 812 })
    const controls = page.locator(".live-video-controls")
    const boxes = await controls.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect()
        return {
          x,
          y,
          width,
          height,
          label: button.getAttribute("aria-label"),
        }
      })
    )
    expect(boxes).toHaveLength(6)
    await expect(
      page.getByRole("button", { name: "下载片段", exact: true })
    ).toBeVisible()
    expect(
      Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y))
    ).toBeLessThan(1)
    expect(
      boxes
        .filter((box) => !["播放倍速", "下载片段"].includes(box.label ?? ""))
        .every((b) => Math.abs(b.width - b.height) < 1)
    ).toBe(true)
    expect(
      boxes.find((box) => box.label === "下载片段")!.width
    ).toBeLessThanOrEqual(36)
    await page
      .locator(".playback-player")
      .screenshot({ path: `/tmp/hikvision-playback-${codec}-mobile.png` })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    await page.getByRole("button", { name: "关闭回放" }).click()
    await expect(page.locator("video")).toHaveCount(0)
    await expect.poll(() => deleted.length).toBe(1)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { playbackAudioStats: { closed: number } })
              .playbackAudioStats.closed
        )
      )
      .toBe(1)
    expect(bodies).toEqual([{ track: "101", date: "2026-10-17", segmentId }])
    await page.getByRole("button", { name: "播放" }).click()
    await expect(page.locator("video")).toHaveCount(1)
    await selectDate(page, "2026-10-16")
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
  await page.getByRole("button", { name: "播放" }).click()
  await expect(page.getByText("读取录像中断，请重试。")).toBeVisible()
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect(page.getByText("正在准备录像", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "取消准备" }).click()
  await expect(page.getByRole("button", { name: "播放" })).toBeEnabled()
  await expect(page.locator("video")).toHaveCount(0)
})
const sequenceSegments = [
  {
    id: "a".repeat(32),
    startAt: "2026-10-16T16:00:00Z",
    endAt: "2026-10-16T17:00:00Z",
    codec: "H.264-BP",
  },
  {
    id: "b".repeat(32),
    startAt: "2026-10-16T17:00:00Z",
    endAt: "2026-10-16T18:00:00Z",
    codec: "H.264-BP",
  },
  {
    id: "c".repeat(32),
    startAt: "2026-10-16T19:00:00Z",
    endAt: "2026-10-16T20:00:00Z",
    codec: "H.264-BP",
  },
]
async function mockSequence(page: Page) {
  const posts: { track: string; date: string; segmentId: string }[] = []
  const events: string[] = []
  const state = {
    complete: true,
    failNext: false,
    holdStatus: undefined as Promise<void> | undefined,
    holdDelete: undefined as Promise<void> | undefined,
  }
  const media = mediaByCodec.h264
  await page.route("**/api/streams/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    if (request.method() === "POST") {
      posts.push(request.postDataJSON())
      events.push(`post:${posts.length}`)
      if (state.failNext)
        return route.fulfill({
          status: 502,
          json: {
            error: {
              code: "MEDIA_REMUX_FAILED",
              message: "下一片段读取失败。",
            },
          },
        })
      const sessionId = `${String(posts.length).repeat(8)}-1111-4111-8111-111111111111`
      return route.fulfill({
        status: 201,
        json: {
          id: sessionId,
          playlistUrl: `/api/streams/${sessionId}/index.m3u8`,
          durationSeconds: 3,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          mode: "stream-copy",
          codec: "h264",
        },
      })
    }
    if (request.method() === "DELETE") {
      events.push("delete:start")
      await state.holdDelete
      events.push("delete:end")
      return route.fulfill({ status: 204 }).catch(() => {})
    }
    if (path.endsWith("/status")) {
      events.push("status")
      await state.holdStatus
      return route
        .fulfill({ json: { complete: state.complete, durationSeconds: 3 } })
        .catch(() => {})
    }
    if (path.endsWith("/audio")) {
      const after = Number(
        new URL(request.url()).searchParams.get("after") ?? -1
      )
      return route.fulfill({
        json: {
          status: "available",
          videoStartSeconds: 0,
          chunks: audioChunks.filter((chunk) => chunk.sequence > after),
        },
      })
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
  await mockQueries(page, sequenceSegments)
  return { posts, events, state }
}
async function pauseSequenceVideo(page: Page) {
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.readyState)
    )
    .toBeGreaterThanOrEqual(3)
  await page.locator("video").evaluate((video: HTMLVideoElement) => {
    video.loop = true
    video.pause()
  })
}
async function endSequenceVideo(page: Page) {
  await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
    video.loop = false
    video.currentTime = video.duration - 0.15
    await video.play()
  })
}

async function mockProgressivePlayback(page: Page, estimate?: number) {
  const state = { available: 3, complete: false }
  const media = mediaByCodec.h264
  // The second synthetic fragment starts at 3 seconds in the same media clock.
  const next = Buffer.from(media.media)
  const mdhd = media.init.indexOf("mdhd")
  const timescale = media.init.readUInt32BE(mdhd + 16)
  const tfdt = next.indexOf("tfdt")
  if (next[tfdt + 4] === 1)
    next.writeBigUInt64BE(
      next.readBigUInt64BE(tfdt + 8) + BigInt(timescale * 3),
      tfdt + 8
    )
  else next.writeUInt32BE(next.readUInt32BE(tfdt + 8) + timescale * 3, tfdt + 8)
  await page.route("**/api/streams/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "POST")
      return route.fulfill({
        status: 201,
        json: {
          id,
          playlistUrl: `/api/streams/${id}/index.m3u8`,
          durationSeconds: 3,
          estimatedDurationSeconds: estimate,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          mode: "stream-copy",
          codec: "h264",
        },
      })
    if (route.request().method() === "DELETE")
      return route.fulfill({ status: 204 })
    if (path.endsWith("/status"))
      return route.fulfill({
        json: {
          complete: state.complete,
          durationSeconds: state.available,
          estimatedDurationSeconds: estimate,
          ...(state.complete ? { totalDurationSeconds: state.available } : {}),
        },
      })
    if (path.endsWith("index.m3u8"))
      return route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        body: `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3.000000,\n0.m4s\n${state.available > 3 ? "#EXTINF:3.000000,\n1.m4s\n" : ""}${state.complete ? "#EXT-X-ENDLIST\n" : ""}`,
      })
    return route.fulfill({
      contentType: path.endsWith("init.mp4")
        ? "video/mp4"
        : "video/iso.segment",
      body: path.endsWith("init.mp4")
        ? media.init
        : path.endsWith("1.m4s")
          ? next
          : media.media,
    })
  })
  await mockQueries(page)
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await pauseSequenceVideo(page)
  return state
}

test("progressive playback keeps its scale, waits for a requested time and calibrates at completion", async ({
  page,
}) => {
  const state = await mockProgressivePlayback(page, 60)
  const slider = page.getByRole("slider", { name: "播放进度" })
  await expect(slider).toHaveAttribute("max", "60")
  await expect(page.getByText("约 01:00", { exact: true })).toBeVisible()
  await slider.fill("5")
  await expect(
    page.getByText("正在读取至 00:05，已读取至 00:03", { exact: true })
  ).toBeVisible()
  expect(
    await page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)
  ).toBeLessThan(3)
  await page.getByRole("button", { name: "取消定位" }).click()
  await page.getByRole("button", { name: "定位时间" }).click()
  await page
    .getByRole("textbox", { name: "文件内时间", exact: true })
    .fill("00:99")
  await page.getByRole("button", { name: "跳转", exact: true }).click()
  await expect(
    page.getByText("请输入分:秒或时:分:秒，例如 01:20:00。", { exact: true })
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "文件内时间", exact: true })
    .fill("00:05")
  await page.getByRole("button", { name: "跳转", exact: true }).click()
  state.available = 6
  await expect
    .poll(
      () =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      { timeout: 15000 }
    )
    .toBeCloseTo(5, 0)
  await expect(page.getByRole("button", { name: "取消定位" })).toHaveCount(0)
  await expect(slider).toHaveAttribute("max", "60")
  expect(
    await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)
  ).toBe(true)
  state.complete = true
  await expect(slider).toHaveAttribute("max", "6")
  await expect(page.getByText("约 01:00", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "定位时间" }).click()
  await page
    .getByRole("textbox", { name: "文件内时间", exact: true })
    .fill("00:10")
  await page.getByRole("button", { name: "跳转", exact: true }).click()
  await expect(
    page.getByText("目标超出录像范围，文件总时长为 00:06。", { exact: true })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "关闭回放" }).click()
})

test("unknown total does not grow a false scale and a waiting target can be replaced or rejected", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const state = await mockProgressivePlayback(page)
  const slider = page.getByRole("slider", { name: "播放进度" })
  await expect(slider).toBeDisabled()
  await expect(page.getByText("时长确认中", { exact: true })).toBeVisible()
  for (const time of ["01:00", "00:10"]) {
    await page.getByRole("button", { name: "定位时间" }).click()
    await page
      .getByRole("textbox", { name: "文件内时间", exact: true })
      .fill(time)
    await page.getByRole("button", { name: "跳转", exact: true }).click()
    await expect(
      page.getByText(`正在读取至 ${time}，已读取至 00:03`, { exact: true })
    ).toBeVisible()
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  state.complete = true
  await expect(
    page.getByText("目标超出录像范围，文件总时长为 00:03。", { exact: true })
  ).toBeVisible()
  await expect(slider).toHaveAttribute("max", "3")
  await expect(page.getByRole("button", { name: "取消定位" })).toHaveCount(0)
  await page.getByRole("button", { name: "关闭回放" }).click()
})

test("continuous playback confirms completion, releases before next file and preserves controls", async ({
  page,
}) => {
  const { posts, events, state } = await mockSequence(page)
  await expect(page.getByRole("switch", { name: "连续播放" })).not.toBeChecked()
  expect(posts).toHaveLength(0)
  await page.getByRole("switch", { name: "连续播放" }).click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await pauseSequenceVideo(page)
  await page.getByRole("button", { name: "播放倍速" }).click()
  await page.getByRole("button", { name: "2×", exact: true }).click()
  await page.getByRole("switch", { name: "声音", exact: true }).click()
  await page.locator("video").dispatchEvent("ended")
  expect(events.filter((event) => event === "status")).toHaveLength(0)
  expect(posts).toHaveLength(1)
  state.complete = false
  await endSequenceVideo(page)
  await expect(
    page.getByText("录像尚未读取完成，请稍后继续播放。")
  ).toBeVisible()
  expect(posts).toHaveLength(1)
  state.complete = true
  let releaseDelete!: () => void
  state.holdDelete = new Promise<void>((resolve) => {
    releaseDelete = resolve
  })
  await endSequenceVideo(page)
  await expect.poll(() => events.includes("delete:start")).toBe(true)
  expect(posts).toHaveLength(1)
  state.holdDelete = undefined
  releaseDelete()
  await expect.poll(() => posts.length).toBe(2)
  await pauseSequenceVideo(page)
  expect(events.indexOf("delete:end")).toBeLessThan(events.indexOf("post:2"))
  await expect(page.locator(".timeline-segment").nth(1)).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  expect(
    await page
      .locator("video")
      .evaluate((video: HTMLVideoElement) => video.playbackRate)
  ).toBe(2)
  await expect(
    page.getByRole("switch", { name: "声音", exact: true })
  ).toBeChecked()
  await endSequenceVideo(page)
  await expect.poll(() => posts.length).toBe(3)
  await pauseSequenceVideo(page)
  await expect(
    page.getByText(/搜索结果中间有 1 小时 0 分未覆盖区间/)
  ).toBeVisible()
  await endSequenceVideo(page)
  await expect(page.getByText("已播放到当日最后一个片段。")).toBeVisible()
  await expect(page.getByRole("switch", { name: "连续播放" })).not.toBeChecked()
  await expect(page.locator("video")).toHaveCount(0)
  expect(posts.map((body) => body.segmentId)).toEqual(
    sequenceSegments.map((segment) => segment.id)
  )
  expect(events.filter((event) => event === "delete:end")).toHaveLength(3)
})

test("continuous playback cancels pending completion on close, selection and date switch", async ({
  page,
}) => {
  const { posts, events, state } = await mockSequence(page)
  await page.getByRole("switch", { name: "连续播放" }).click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await pauseSequenceVideo(page)
  let releaseStatus!: () => void
  state.holdStatus = new Promise<void>((resolve) => {
    releaseStatus = resolve
  })
  await endSequenceVideo(page)
  await expect
    .poll(() => events.filter((event) => event === "status").length)
    .toBe(1)
  await page.getByRole("button", { name: "关闭回放" }).click()
  state.holdStatus = undefined
  releaseStatus()
  await expect(page.getByRole("switch", { name: "连续播放" })).not.toBeChecked()
  await page.locator(".timeline-segment").nth(1).click()
  await expect(
    page.getByRole("button", { name: "播放", exact: true })
  ).toBeEnabled()
  expect(posts).toHaveLength(1)
  await page.getByRole("switch", { name: "连续播放" }).click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await pauseSequenceVideo(page)
  state.holdStatus = new Promise<void>((resolve) => {
    releaseStatus = resolve
  })
  await endSequenceVideo(page)
  await expect
    .poll(() => events.filter((event) => event === "status").length)
    .toBe(2)
  await page.locator(".timeline-segment").first().click()
  state.holdStatus = undefined
  releaseStatus()
  await expect(page.locator("video")).toHaveCount(0)
  expect(posts).toHaveLength(2)
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await pauseSequenceVideo(page)
  state.holdStatus = new Promise<void>((resolve) => {
    releaseStatus = resolve
  })
  await endSequenceVideo(page)
  await expect
    .poll(() => events.filter((event) => event === "status").length)
    .toBe(3)
  await selectDate(page, "2026-10-16")
  state.holdStatus = undefined
  releaseStatus()
  await expect(page.locator("video")).toHaveCount(0)
  expect(posts).toHaveLength(3)
  await expect
    .poll(() => events.filter((event) => event === "delete:end").length)
    .toBe(3)
})

test("continuous playback is opt-in and a failed next file does not loop retries", async ({
  page,
}) => {
  const { posts, state } = await mockSequence(page)
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await pauseSequenceVideo(page)
  await endSequenceVideo(page)
  await expect(
    page.getByRole("button", { name: "播放录像", exact: true })
  ).toBeVisible()
  expect(posts).toHaveLength(1)
  await page.getByRole("switch", { name: "连续播放" }).click()
  state.failNext = true
  await endSequenceVideo(page)
  await expect(page.getByText("下一片段读取失败。")).toBeVisible()
  await expect(page.getByRole("switch", { name: "连续播放" })).not.toBeChecked()
  expect(posts).toHaveLength(2)
  await expect(
    page.getByRole("button", { name: "重试", exact: true })
  ).toBeEnabled()
})

test("a synchronous audio permission failure remains isolated from video", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(window, "AudioContext", {
      value: class {
        constructor() {
          throw new DOMException("Audio denied", "NotAllowedError")
        }
      },
    })
  })
  const { posts } = await mockSequence(page)
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await pauseSequenceVideo(page)
  await page.getByRole("switch", { name: "声音", exact: true }).click()
  await expect(
    page.getByText("浏览器尚未允许声音，请再次点击开启声音。")
  ).toBeVisible()
  await expect(
    page.getByRole("switch", { name: "声音", exact: true })
  ).not.toBeChecked()
  await page.getByRole("button", { name: "播放录像", exact: true }).click()
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.currentTime)
    )
    .toBeGreaterThan(0)
  expect(posts).toHaveLength(1)
  expect(errors).toEqual([])
  await page.getByRole("button", { name: "关闭回放" }).click()
})

test("a stalled playback preparation times out and stops the sequence", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    AbortSignal.timeout = (milliseconds: number) =>
      timeout(milliseconds === 35000 ? 100 : milliseconds)
  })
  const { posts } = await mockSequence(page)
  let attempts = 0
  await page.route("**/api/streams/playback", async (route) => {
    attempts++
    await new Promise((resolve) => setTimeout(resolve, 250))
    await route
      .fulfill({
        status: 503,
        json: { error: { code: "MEDIA_CANCELLED", message: "已取消" } },
      })
      .catch(() => {})
  })
  await page.getByRole("switch", { name: "连续播放" }).click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await expect(page.getByText("准备预览超时，请重试。")).toBeVisible()
  await expect(page.getByRole("switch", { name: "连续播放" })).not.toBeChecked()
  await expect(
    page.getByRole("button", { name: "重试", exact: true })
  ).toBeEnabled()
  await expect(page.locator("video")).toHaveCount(0)
  expect(attempts).toBe(1)
  expect(posts).toHaveLength(0)
})

test("real LAN preview: browser decoding, pause/seek and repeated cleanup", async ({
  page,
}) => {
  test.skip(process.env.NVR_INTEGRATION !== "1", "Explicit LAN opt-in required")
  test.setTimeout(180000)
  await page.addInitScript(() => {
    const stats = { rates: [] as number[], closed: 0 }
    Object.assign(window, { playbackAudioStats: stats })
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args) {
      stats.rates.push(this.playbackRate.value)
      return start.apply(this, args)
    }
    const close = AudioContext.prototype.close
    AudioContext.prototype.close = function () {
      stats.closed++
      return close.call(this)
    }
  })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.name))
  await page.goto("/playback")
  await expect(page.getByLabel("日期", { exact: true })).toBeEnabled()
  await selectDate(page, "2026-10-17")
  await expect(page.getByText("13 个录像片段")).toBeVisible()
  await page.locator(".timeline-segment").first().click()
  for (let attempt = 0; attempt < 2; attempt++) {
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/streams/playback") &&
        response.request().method() === "POST"
    )
    await page.getByRole("button", { name: "播放" }).click()
    const response = await created
    expect(response.status()).toBe(201)
    const session = await response.json()
    try {
      expect(session.mode).toBe("stream-copy")
      expect(session.codec).toBe("hevc")
      expect(JSON.stringify(session)).not.toMatch(
        /rtsp:|playbackURI|Authorization/
      )
      await playAndSeek(page, 10)
      if (attempt === 0) {
        await page.getByRole("switch", { name: "声音" }).click()
        await page
          .getByRole("button", { name: "播放录像", exact: true })
          .click()
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    playbackAudioStats: { rates: number[] }
                  }
                ).playbackAudioStats.rates.length
            )
          )
          .toBeGreaterThan(0)
        await page.getByRole("button", { name: "播放倍速" }).click()
        await page.getByRole("button", { name: "2×", exact: true }).click()
        await expect
          .poll(() =>
            page.evaluate(() =>
              (
                window as unknown as { playbackAudioStats: { rates: number[] } }
              ).playbackAudioStats.rates.includes(2)
            )
          )
          .toBe(true)
        await page
          .getByRole("button", { name: "暂停录像", exact: true })
          .click()
        await expect
          .poll(
            async () =>
              (
                await (
                  await page.request.get(`/api/streams/${session.id}/status`)
                ).json()
              ).complete,
            { timeout: 120000, intervals: [1000] }
          )
          .toBe(true)
        const status = await (
          await page.request.get(`/api/streams/${session.id}/status`)
        ).json()
        expect(status.durationSeconds).toBeGreaterThan(30)
        const target = Math.floor((status.durationSeconds - 10) * 10) / 10
        await expect
          .poll(() =>
            page.locator("video").evaluate((v: HTMLVideoElement) => v.duration)
          )
          .toBeGreaterThan(target)
        const tail = await (
          await page.request.get(
            `/api/streams/${session.id}/audio?after=-1&at=${target.toFixed(3)}`
          )
        ).json()
        expect(tail.status).toBe("available")
        expect(tail.chunks.length).toBeGreaterThan(0)
        const previous = await page.evaluate(
          () =>
            (window as unknown as { playbackAudioStats: { rates: number[] } })
              .playbackAudioStats.rates.length
        )
        await page
          .getByRole("slider", { name: "播放进度" })
          .fill(String(target))
        await page
          .getByRole("button", { name: "播放录像", exact: true })
          .click()
        await expect
          .poll(() =>
            page
              .locator("video")
              .evaluate((v: HTMLVideoElement) => v.currentTime)
          )
          .toBeGreaterThan(target)
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    playbackAudioStats: { rates: number[] }
                  }
                ).playbackAudioStats.rates.length
            )
          )
          .toBeGreaterThan(previous)
        await page
          .getByRole("button", { name: "暂停录像", exact: true })
          .click()
      }
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
      await page.getByRole("button", { name: "关闭回放" }).click()
      expect((await removed).status()).toBe(204)
      expect((await page.request.get(session.playlistUrl)).status()).toBe(404)
    } finally {
      await page.request.delete(`/api/streams/${session.id}`)
    }
  }
  expect(errors).toEqual([])
})
