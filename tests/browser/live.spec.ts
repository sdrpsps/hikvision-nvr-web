import { readFileSync } from "node:fs"
import { execFileSync, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { test, expect, type Page } from "@playwright/test"
import { selectOption } from "./controls"
import { mp4Boxes, splitFragmentedMp4 } from "../../server/mp4"
import { LiveSessions } from "../../server/live"
import { readNvrConfig } from "../../server/config"
import { FragmentedMp4Demuxer } from "../../lib/media-export"

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
  // Keep navigation to playback on synthetic data as well.
  await page.route("**/api/recordings?**", (route) => {
    const query = new URL(route.request().url()).searchParams
    return route.fulfill({
      json: {
        trackId: query.get("track"),
        date: query.get("date"),
        timeZone: "Asia/Shanghai",
        range: {
          startAt: "2026-10-16T16:00:00Z",
          endAt: "2026-10-17T16:00:00Z",
        },
        segments: [],
        coverage: [],
        gaps: [],
        warnings: [],
      },
    })
  })
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
    await expect(
      page.getByRole("button", { name: "停止全部预览" })
    ).toBeDisabled()
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
      const playButtons = await page
        .locator(".stream-idle")
        .evaluateAll((frames) =>
          frames.map((frame) => {
            const button = frame.querySelector<HTMLElement>(
              'button[aria-label="开始预览"]'
            )!
            const bounds = frame.getBoundingClientRect()
            const control = button.getBoundingClientRect()
            return {
              centeredX:
                Math.abs(
                  control.x + control.width / 2 - bounds.x - bounds.width / 2
                ) < 1,
              centeredY:
                Math.abs(
                  control.y + control.height / 2 - bounds.y - bounds.height / 2
                ) < 1,
              visible: control.width > 0 && control.height > 0,
            }
          })
        )
      expect(playButtons).toHaveLength(count)
      for (const button of playButtons)
        expect(button).toEqual({
          centeredX: true,
          centeredY: true,
          visible: true,
        })
      const headings = await page
        .locator(".live-window-heading")
        .evaluateAll((elements) =>
          elements.map((heading) => {
            const record = heading.querySelector(".live-record-trigger")!
            const label = record.querySelector("span")!
            const channel = heading.querySelector(
              '[data-slot="select-trigger"]'
            )!
            const headingBox = heading.getBoundingClientRect()
            const recordBox = record.getBoundingClientRect()
            const labelBox = label.getBoundingClientRect()
            const channelBox = channel.getBoundingClientRect()
            return {
              compact: headingBox.width <= 192,
              headingFits: heading.scrollWidth <= heading.clientWidth + 1,
              recordHeight: recordBox.height,
              recordFits:
                recordBox.left >= headingBox.left - 1 &&
                recordBox.right <= headingBox.right + 1,
              label: label.textContent,
              labelHidden: getComputedStyle(label).display === "none",
              labelVisible:
                getComputedStyle(label).visibility === "visible" &&
                labelBox.width > 0 &&
                labelBox.height > 0 &&
                labelBox.left >= recordBox.left - 1 &&
                labelBox.right <= recordBox.right + 1,
              title: record.getAttribute("title"),
              channelFits:
                channelBox.width > 0 &&
                channelBox.left >= headingBox.left - 1 &&
                channelBox.right <= recordBox.left + 1,
            }
          })
        )
      expect(headings).toHaveLength(count)
      for (const heading of headings)
        expect(heading).toEqual({
          compact: heading.compact,
          headingFits: true,
          recordHeight: 28,
          recordFits: true,
          label: "录制",
          labelHidden: heading.compact,
          labelVisible: !heading.compact,
          title: "手动录制到本机",
          channelFits: true,
        })
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
    await expect(
      page.getByRole("button", { name: "停止全部预览" })
    ).toBeEnabled()
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
    await page.getByRole("button", { name: "停止全部预览" }).click()
    await expect.poll(() => deleted.length).toBe(3)
    await expect(page.locator("video")).toHaveCount(0)
    await window1.getByRole("button", { name: "开始预览" }).click()
    await expect(page.locator("video")).toHaveCount(1)
    await page.getByRole("link", { name: "录像回放" }).click()
    await expect(page).toHaveURL(/\/playback$/)
    await expect.poll(() => deleted.length).toBe(4)
  })
test.describe("live startup buffering", () => {
  async function prepare(page: Page) {
    const media = splitFragmentedMp4(
      readFileSync(
        new URL("../../fixtures/synthetic-preview.mp4", import.meta.url)
      )
    )
    const deleted: string[] = []
    let created = 0
    // Keep real decoded media at its first frame until the test asks it to play.
    // This models native HLS exposing loadeddata before it starts playback.
    await page.addInitScript(() => {
      document.addEventListener(
        "loadstart",
        (event) => {
          if (event.target instanceof HTMLVideoElement)
            event.target.autoplay = false
        },
        true
      )
      document.addEventListener(
        "loadeddata",
        (event) => {
          if (event.target instanceof HTMLVideoElement)
            event.target.dataset.firstFrameReady = "true"
        },
        true
      )
    })
    await channels(page)
    await page.route("**/api/streams/**", (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname
      if (request.method() === "POST") {
        const id = `11111111-1111-4111-8111-${String(++created).padStart(12, "0")}`
        return route.fulfill({
          status: 201,
          json: {
            id,
            playlistUrl: `/api/streams/${id}/index.m3u8`,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            mode: "stream-copy",
            codec: "h264",
          },
        })
      }
      if (request.method() === "DELETE") {
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
    return {
      first: page.getByRole("region", { name: "窗口 1", exact: true }),
      deleted,
    }
  }

  test("covers a decoded first frame until playback, and can stop and reconnect", async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.name))
    await page.clock.install()
    const { first, deleted } = await prepare(page)
    await first.getByRole("button", { name: "开始预览" }).click()
    const video = first.locator("video")
    await expect(video).toHaveAttribute("data-first-frame-ready", "true")
    expect(
      await video.evaluate((element: HTMLVideoElement) => ({
        hasMedia: element.buffered.length > 0,
        paused: element.paused,
        time: element.currentTime,
        display: getComputedStyle(element).display,
        visibility: getComputedStyle(element).visibility,
        opacity: getComputedStyle(element).opacity,
      }))
    ).toEqual({
      hasMedia: true,
      paused: true,
      time: 0,
      display: "block",
      visibility: "visible",
      opacity: "1",
    })
    await expect(first.getByRole("status")).toHaveText("正在缓冲画面")
    const detachedVideo = await video.elementHandle()
    await first.getByRole("button", { name: "停止预览" }).click()
    await expect.poll(() => deleted.length).toBe(1)
    await expect(video).toHaveCount(0)
    await expect(first.getByRole("status")).toHaveCount(0)

    await first.getByRole("button", { name: "开始预览" }).click()
    await expect(video).toHaveAttribute("data-first-frame-ready", "true")
    await detachedVideo!.evaluate((element) => {
      element.dispatchEvent(new Event("playing"))
      element.dispatchEvent(new Event("error"))
    })
    await expect(first.getByRole("status")).toHaveText("正在缓冲画面")
    expect(deleted).toHaveLength(1)
    await video.evaluate((element: HTMLVideoElement) => element.play())
    await expect(first.getByRole("status")).toHaveCount(0)
    await expect
      .poll(() =>
        video.evaluate(
          (element: HTMLVideoElement) =>
            element.getVideoPlaybackQuality().totalVideoFrames
        )
      )
      .toBeGreaterThan(3)
    await page.clock.fastForward(31000)
    await expect(video).toHaveCount(1)
    await expect(first.getByRole("status")).toHaveCount(0)
    expect(deleted).toHaveLength(1)
    await expect(
      page.locator('[data-sonner-toast][data-type="error"]')
    ).toHaveCount(0)
    await first.getByRole("button", { name: "停止预览" }).click()
    await expect.poll(() => deleted.length).toBe(2)
    expect(errors).toEqual([])
  })

  test("releases a stream that never starts playing and can retry", async ({
    page,
  }) => {
    await page.clock.install()
    const { first, deleted } = await prepare(page)
    await first.getByRole("button", { name: "开始预览" }).click()
    await expect(first.locator("video")).toHaveAttribute(
      "data-first-frame-ready",
      "true"
    )
    await expect(first.getByRole("status")).toHaveText("正在缓冲画面")
    await page.clock.fastForward(31000)
    await expect.poll(() => deleted.length).toBe(1)
    await expect(first.locator("video")).toHaveCount(0)
    await expect(first.getByRole("status")).toHaveCount(0)
    const errorToast = page.locator('[data-sonner-toast][data-type="error"]')
    await expect(errorToast).toHaveCount(1)
    await expect(errorToast).toContainText("等待实时画面缓冲超时，请重新连接。")
    await first.getByRole("button", { name: "重试", exact: true }).click()
    await expect(first.locator("video")).toHaveAttribute(
      "data-first-frame-ready",
      "true"
    )
    await expect(first.getByRole("status")).toHaveText("正在缓冲画面")
    await first.getByRole("button", { name: "停止预览" }).click()
    await expect.poll(() => deleted.length).toBe(2)
  })
})
for (const codec of ["h264", "hevc"] as const)
  test(`short live ${codec} fragments keep long GOPs decodable while rolling and joining late`, async ({
    page,
  }) => {
    test.setTimeout(60000)
    // Repackage existing synthetic three-second GOPs without re-encoding. Most
    // half-second fragments depend on the keyframe in an earlier fragment.
    const bytes = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-stream_loop",
        "7",
        "-i",
        new URL(
          `../../fixtures/${codec === "h264" ? "synthetic-preview.mp4" : "synthetic-preview-hevc.mp4"}`,
          import.meta.url
        ).pathname,
        "-t",
        "24",
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-an",
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "500000",
        "-f",
        "mp4",
        "pipe:1",
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    )
    const boxes = mp4Boxes(bytes),
      init = bytes.subarray(0, boxes.find((box) => box.type === "moof")!.start),
      fragments: Buffer[] = [],
      verifier = new FragmentedMp4Demuxer(),
      independent: boolean[] = []
    verifier.push(init)
    let moof: Buffer | undefined
    for (const box of boxes) {
      if (box.type === "moof") moof = bytes.subarray(box.start, box.end)
      else if (box.type === "mdat") {
        const fragment = Buffer.concat([
          moof!,
          bytes.subarray(box.start, box.end),
        ])
        const packets = verifier.push(fragment)
        independent.push(packets[0].keyframe)
        expect(
          packets.reduce((sum, packet) => sum + (packet.duration ?? 0), 0)
        ).toBeCloseTo(0.5, 6)
        fragments.push(fragment)
        moof = undefined
      }
    }
    expect(fragments).toHaveLength(48)
    expect(independent.slice(0, 12)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ])

    const active = new Set<EventEmitter>(),
      timers = new Set<ReturnType<typeof setInterval>>(),
      created: Awaited<ReturnType<LiveSessions["create"]>>[] = [],
      deleted: string[] = [],
      errors: string[] = []
    let launches = 0
    const sessions = new LiveSessions(() => {
      const stdout = new PassThrough(),
        stderr = new PassThrough(),
        audio = new PassThrough()
      // The reopened source starts between keyframes. It must wait for the
      // next decodable anchor instead of exposing the dependent leading tail.
      let at = launches++ === 0 ? 0 : 27
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        stdio: [null, stdout, stderr, audio],
        kill() {
          clearInterval(timer)
          timers.delete(timer)
          active.delete(child)
          stdout.end()
          stderr.end()
          audio.end()
          child.emit("close", 0)
          return true
        },
      })
      active.add(child)
      const feed = () => {
        if (at < fragments.length) stdout.write(fragments[at++])
      }
      const timer = setInterval(feed, 500)
      timer.unref()
      timers.add(timer)
      queueMicrotask(() => {
        stdout.write(init)
        feed()
      })
      return child as unknown as ChildProcess
    })
    const config = readNvrConfig({
      NVR_HOST: "synthetic.test",
      NVR_USERNAME: "synthetic-user",
      NVR_PASSWORD: "synthetic-password",
    })
    const firstFragmentIsIndependent = (id: string) => {
      const playlist = sessions.playlist(id),
        asset = /\n(\d+\.m4s)\n/.exec(playlist)![1],
        parser = new FragmentedMp4Demuxer()
      parser.push(sessions.asset(id, "init.mp4"))
      return parser.push(sessions.asset(id, asset))[0].keyframe
    }
    page.on("pageerror", (error) => errors.push(error.name))
    await channels(page)
    await page.route("**/api/streams/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname,
        [, , , id, asset] = path.split("/")
      if (request.method() === "POST") {
        expect(request.postDataJSON()).toEqual({ track: "101" })
        const session = await sessions.create(
          config,
          async () => "101",
          new AbortController().signal
        )
        created.push(session)
        return route.fulfill({ status: 201, json: session })
      }
      if (request.method() === "DELETE") {
        sessions.delete(id)
        deleted.push(id)
        return route.fulfill({ status: 204 })
      }
      try {
        if (asset === "index.m3u8")
          return route.fulfill({
            contentType: "application/vnd.apple.mpegurl",
            body: sessions.playlist(id),
          })
        return route.fulfill({
          contentType: asset === "init.mp4" ? "video/mp4" : "video/iso.segment",
          body: sessions.asset(id, asset),
        })
      } catch {
        return route.fulfill({ status: 404 })
      }
    })
    try {
      await page.goto("/")
      const first = page.getByRole("region", { name: "窗口 1", exact: true })
      await first.getByRole("button", { name: "开始预览" }).click()
      const video = first.locator("video")
      await expect
        .poll(() =>
          video.evaluate(
            (element: HTMLVideoElement) =>
              element.getVideoPlaybackQuality().totalVideoFrames
          )
        )
        .toBeGreaterThan(3)
      await expect(first.getByRole("status")).toHaveCount(0)
      const id = created[0].id
      await expect
        .poll(
          () =>
            Number(
              /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(sessions.playlist(id))![1]
            ),
          { timeout: 20000 }
        )
        .toBeGreaterThan(0)
      const playlist = sessions.playlist(id),
        durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((match) =>
          Number(match[1])
        )
      expect(playlist).toContain("#EXT-X-TARGETDURATION:1\n")
      expect(playlist).not.toContain("#EXT-X-INDEPENDENT-SEGMENTS")
      expect(
        durations.every((duration) => Math.abs(duration - 0.5) < 0.00001)
      ).toBe(true)
      expect(
        durations.reduce((sum, duration) => sum + duration, 0)
      ).toBeGreaterThanOrEqual(12)
      expect(firstFragmentIsIndependent(id)).toBe(true)
      const before = await video.evaluate((element: HTMLVideoElement) => ({
        time: element.currentTime,
        frames: element.getVideoPlaybackQuality().totalVideoFrames,
      }))
      // A seek across an evicted GOP advances currentTime without decoding.
      await expect
        .poll(() =>
          video.evaluate(
            (element: HTMLVideoElement, before) =>
              element.currentTime > before.time + 2 &&
              element.getVideoPlaybackQuality().totalVideoFrames >
                before.frames + 20,
            before
          )
        )
        .toBe(true)
      expect(
        await video.evaluate(
          (element: HTMLVideoElement) =>
            element.getVideoPlaybackQuality().totalVideoFrames
        )
      ).toBeGreaterThan(100)
      await first.getByRole("button", { name: "停止预览" }).click()
      await expect.poll(() => deleted).toEqual([id])
      expect(active.size).toBe(0)
      expect(timers.size).toBe(0)

      await first.getByRole("button", { name: "开始预览" }).click()
      await expect.poll(() => created.length).toBe(2)
      expect(firstFragmentIsIndependent(created[1].id)).toBe(true)
      await expect
        .poll(() =>
          video.evaluate(
            (element: HTMLVideoElement) =>
              element.getVideoPlaybackQuality().totalVideoFrames
          )
        )
        .toBeGreaterThan(3)
      await expect(first.getByRole("status")).toHaveCount(0)
      await first.getByRole("button", { name: "停止预览" }).click()
      await expect.poll(() => deleted.length).toBe(2)
      expect(active.size).toBe(0)
      expect(timers.size).toBe(0)
      expect(errors).toEqual([])
      await expect(
        page.locator('[data-sonner-toast][data-type="error"]')
      ).toHaveCount(0)
    } finally {
      sessions.dispose()
      for (const timer of timers) clearInterval(timer)
    }
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
  await expect(first.locator('.stream-player [role="alert"]')).toHaveText(
    "实时连接超时。"
  )
  await expect(
    page.getByRole("button", { name: "停止全部预览" })
  ).toBeDisabled()
  await first.getByRole("button", { name: "重试", exact: true }).click()
  await expect(first.getByRole("status")).toHaveText("正在连接通道")
  await expect(first.locator(".stream-idle .animate-spin")).toBeVisible()
  await expect(page.getByRole("button", { name: "停止全部预览" })).toBeEnabled()
  for (const width of [1440, 1280, 375]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const count of [4, 16]) {
      await page
        .getByRole("button", { name: `${count} 路`, exact: true })
        .click()
      const row = await first.locator(".preview-control-row").evaluate((el) => {
        return {
          statusCount: el.querySelectorAll('[role="status"]').length,
          cancelCount: el.querySelectorAll('button[aria-label="取消准备"]')
            .length,
          fits: el.scrollWidth <= el.clientWidth,
        }
      })
      expect(row).toEqual({ statusCount: 0, cancelCount: 1, fits: true })
      await expect(first.getByRole("status")).toHaveCount(1)
      if (width === 1440 && count === 4)
        await first.screenshot({
          path: test.info().outputPath("preparing-inline.png"),
        })
    }
  }
  await first.getByRole("button", { name: "取消准备" }).click()
  finishPreparation()
  await expect(first.getByRole("button", { name: "开始预览" })).toBeEnabled()
  await expect(
    page.getByRole("button", { name: "停止全部预览" })
  ).toBeDisabled()
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
  const errorToast = page.locator('[data-sonner-toast][data-type="error"]')
  await expect(errorToast).toHaveCount(1)
  await expect(errorToast).toContainText("通道读取失败")
  await expect(errorToast).toContainText("无法连接设备。")
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0)
  await page.getByRole("button", { name: "收起通道", exact: true }).click()
  await expect(errorToast).toHaveCount(1)
  await errorToast.getByRole("button", { name: "关闭提示" }).click()
  await expect(errorToast).toHaveCount(0)
  await page.getByRole("button", { name: "展开通道", exact: true }).click()
  await expect(errorToast).toHaveCount(0)
  // A new failed request must notify again, even with the same message.
  // Layout changes and dismissal must not replay a cached failure.
  await page.getByRole("button", { name: "刷新通道" }).click()
  await expect(errorToast).toHaveCount(1)
  await expect(errorToast).toContainText("通道读取失败")
  retry = true
  await page.getByRole("button", { name: "刷新通道" }).click()
  await expect(page.getByText("暂无通道")).toBeVisible()
  await expect(errorToast).toHaveCount(0)
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
      await expect(
        page
          .locator('.stream-player [role="alert"]')
          .filter({ hasText: "第三路连接超时。" })
      ).toBeVisible()
      await page.getByRole("button", { name: "全部开始" }).click()
      await expect.poll(() => tracks.length).toBe(4)
      await expect(page.locator("video")).toHaveCount(2)
      await page.getByRole("button", { name: "全部开始" }).click()
      expect(tracks[0]).toBe("101")
      expect(tracks.slice(1).sort()).toEqual(["201", "301", "301"])
      await page.getByRole("button", { name: "停止全部预览" }).click()
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
      await page.getByRole("button", { name: "停止全部预览" }).click()
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
    if (codec === "h264") {
      const fullscreenControls = first.locator(".fullscreen-controls")
      await expect(fullscreenControls).toHaveAttribute("inert", "", {
        timeout: 5000,
      })
      await expect(fullscreenControls).toHaveCSS("opacity", "0")
      await page.mouse.move(100, 100)
      await expect(fullscreenControls).not.toHaveAttribute("inert")
      await expect(fullscreenControls).toHaveCSS("opacity", "1")
      await expect(
        first.getByRole("button", { name: "停止预览" })
      ).toBeVisible()
    }
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
