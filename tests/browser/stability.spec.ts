import { readFileSync } from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { splitFragmentedMp4 } from "../../server/mp4"

const media = splitFragmentedMp4(
  readFileSync(new URL("../../fixtures/synthetic-preview.mp4", import.meta.url))
)

async function installWall(page: Page, pending = false) {
  const active = new Set<string>(),
    deleted: string[] = [],
    tracks: string[] = []
  let sequence = 0,
    hold = pending,
    resume!: () => void
  const preparation = new Promise<void>((resolve) => {
    resume = resolve
  })
  await page.addInitScript(() => {
    const stats = { created: 0, terminated: 0 }
    Object.assign(window, { stabilityWorkers: stats })
    const OriginalWorker = window.Worker
    window.Worker = class extends OriginalWorker {
      private stopped = false
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        stats.created++
      }
      terminate() {
        if (!this.stopped) {
          this.stopped = true
          stats.terminated++
        }
        super.terminate()
      }
    }
  })
  // Catch every API request: this suite must never fall through to a real NVR.
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname
    if (path === "/api/channels")
      return route.fulfill({
        json: {
          timeZone: "Asia/Shanghai",
          today: "2026-10-17",
          channels: Array.from({ length: 16 }, (_, index) => ({
            id: String((index + 1) * 100 + 1),
            name: `合成通道 ${index + 1}`,
            configuredEnabled: true,
          })),
        },
      })
    if (path === "/api/device")
      return route.fulfill({ json: { model: "SYNTHETIC", firmware: "TEST" } })
    if (path === "/api/streams/live" && request.method() === "POST") {
      tracks.push(request.postDataJSON().track)
      if (hold) {
        await preparation
        // The simulated backend honours cancellation without allocating a session.
        return route.fulfill({ status: 499, body: "" }).catch(() => {})
      }
      const id = `55555555-5555-4555-8555-${String(++sequence).padStart(12, "0")}`
      active.add(id)
      return route.fulfill({
        status: 201,
        json: {
          id,
          playlistUrl: `/api/streams/${id}/index.m3u8`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          mode: "stream-copy",
          codec: "h264",
        },
      })
    }
    const id = path.split("/")[3]
    if (request.method() === "DELETE" && id) {
      deleted.push(id)
      active.delete(id)
      return route.fulfill({ status: 204 })
    }
    if (!active.has(id)) return route.fulfill({ status: 404, body: "" })
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
  return {
    active,
    deleted,
    tracks,
    releasePending() {
      hold = false
      resume()
    },
  }
}

async function expectDecoded(page: Page, count: number) {
  await expect(page.locator("video")).toHaveCount(count)
  await page.locator("video").evaluateAll((videos) => {
    for (const video of videos as HTMLVideoElement[]) video.loop = true
  })
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .evaluateAll(
            (videos) =>
              videos.filter(
                (element) =>
                  (element as HTMLVideoElement).getVideoPlaybackQuality()
                    .totalVideoFrames > 3
              ).length
          ),
      { timeout: 20_000 }
    )
    .toBe(count)
}

async function expectWorkersReleased(page: Page) {
  // hls.js can process fMP4 without a Worker. Any workers it does allocate must
  // still terminate when the players are removed.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stats = (
          window as unknown as {
            stabilityWorkers: { created: number; terminated: number }
          }
        ).stabilityWorkers
        return stats.created - stats.terminated
      })
    )
    .toBe(0)
}

test("sixteen synthetic decoders survive repeated start, stop, shrink and navigation", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1920, height: 1400 })
  const wall = await installWall(page)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.name))
  await page.goto("/")
  await page.getByRole("button", { name: "16 路", exact: true }).click()
  expect(wall.tracks).toEqual([])
  for (let round = 0; round < 2; round++) {
    await page.getByRole("button", { name: "全部开始" }).click()
    await expectDecoded(page, 16)
    expect(wall.active.size).toBe(16)
    expect(new Set(wall.tracks.slice(-16)).size).toBe(16)
    await page.getByRole("button", { name: "停止全部预览" }).click()
    await expect(page.locator("video")).toHaveCount(0)
    await expect.poll(() => wall.active.size).toBe(0)
    await expectWorkersReleased(page)
  }
  expect(wall.deleted).toHaveLength(32)
  await page.getByRole("button", { name: "全部开始" }).click()
  await expectDecoded(page, 16)
  await page.getByRole("button", { name: "4 路", exact: true }).click()
  await expect.poll(() => wall.active.size).toBe(4)
  await expect(page.locator("video")).toHaveCount(4)
  expect(wall.deleted).toHaveLength(44)
  await page.getByRole("link", { name: "录像回放" }).click()
  await expect.poll(() => wall.active.size).toBe(0)
  await expectWorkersReleased(page)
  expect(wall.deleted).toHaveLength(48)
  expect(new Set(wall.deleted).size).toBe(48)
  expect(errors).toEqual([])
})

test("stopping sixteen pending starts aborts every request and permits a clean restart", async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1920, height: 1400 })
  const wall = await installWall(page, true)
  const aborted = new Set<string>()
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/api/streams/live"))
      aborted.add(request.postDataJSON().track)
  })
  try {
    await page.goto("/")
    await page.getByRole("button", { name: "16 路", exact: true }).click()
    await page.getByRole("button", { name: "全部开始" }).click()
    await expect.poll(() => wall.tracks.length).toBe(16)
    await expect(page.getByRole("button", { name: "取消准备" })).toHaveCount(16)
    await page.getByRole("button", { name: "停止全部预览" }).click()
    await expect.poll(() => aborted.size).toBe(16)
    await expect(page.locator("video")).toHaveCount(0)
    expect(wall.active.size).toBe(0)
    wall.releasePending()
    await page.getByRole("button", { name: "全部开始" }).click()
    await expectDecoded(page, 16)
    expect(wall.active.size).toBe(16)
    await page.getByRole("button", { name: "停止全部预览" }).click()
    await expect.poll(() => wall.active.size).toBe(0)
    await expectWorkersReleased(page)
    expect(wall.deleted).toHaveLength(16)
  } finally {
    wall.releasePending()
  }
})
