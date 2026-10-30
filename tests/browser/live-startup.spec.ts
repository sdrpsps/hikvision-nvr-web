import { readFileSync } from "node:fs"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { splitFragmentedMp4 } from "../../server/mp4"

type Codec = "h264" | "hevc"
type Startup = {
  apiMs: number | null
  playingMs: number | null
  firstFrameMs: number | null
  firstFrameMediaSeconds: number | null
  frameCallbackSupported: boolean
}
type Sample = {
  startup: Startup
  decodedFrames: number
  totalFrames: number
  droppedFrames: number
  forwardBufferSeconds: number
  waitingAfterPlaying: number
  loadstarts: number
}
type Probe = {
  loadstarts: number
  played: boolean
  waitingAfterPlaying: number
}
type FrameGate = {
  supported: boolean
  latest(video: HTMLVideoElement): number | null
  state(id: number): {
    arrived: boolean
    cancelled: boolean
    delivered: boolean
  } | null
  release(id: number): boolean
  late(id: number): boolean
}

declare global {
  interface Window {
    __syntheticStartupProbe: WeakMap<HTMLVideoElement, Probe>
    __syntheticStartupFrameGate: FrameGate
  }
}

// Prebuffered three-second VOD fixtures measure this frontend only. These are
// neither live upstream measurements nor cold device/decoder startup timings.
async function prepare(page: Page, codec: Codec) {
  const media = splitFragmentedMp4(
    readFileSync(
      new URL(
        `../../fixtures/${codec === "hevc" ? "synthetic-preview-hevc.mp4" : "synthetic-preview.mp4"}`,
        import.meta.url
      )
    )
  )
  const active = new Set<string>()
  const deleted: string[] = []
  let created = 0
  // Unrecognized API traffic must never reach a configured device.
  await page.route("**/api/**", (route) => route.fulfill({ status: 404 }))
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-30",
        channels: [{ id: "101", name: "合成通道", configuredEnabled: true }],
      },
    })
  )
  await page.route("**/api/streams/**", (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === "POST" && path === "/api/streams/live") {
      expect(request.postDataJSON()).toEqual({ track: "101" })
      const id = `11111111-1111-4111-8111-${String(++created).padStart(12, "0")}`
      active.add(id)
      return route.fulfill({
        status: 201,
        json: {
          id,
          playlistUrl: `/api/streams/${id}/index.m3u8`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          mode: "stream-copy",
          codec,
          targetDurationSeconds: 3,
        },
      })
    }
    const match = /^\/api\/streams\/([a-f0-9-]{36})(?:\/([^/]+))?$/.exec(path)
    if (!match || !active.has(match[1])) return route.fulfill({ status: 404 })
    if (request.method() === "DELETE" && !match[2]) {
      active.delete(match[1])
      deleted.push(match[1])
      return route.fulfill({ status: 204 })
    }
    if (request.method() !== "GET") return route.fulfill({ status: 404 })
    const headers = { "Cache-Control": "no-store" }
    if (match[2] === "index.m3u8")
      return route.fulfill({
        headers,
        contentType: "application/vnd.apple.mpegurl",
        body: '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3.000000,\n0.m4s\n#EXT-X-ENDLIST\n',
      })
    if (match[2] === "init.mp4" || match[2] === "0.m4s")
      return route.fulfill({
        headers,
        contentType:
          match[2] === "init.mp4" ? "video/mp4" : "video/iso.segment",
        body: match[2] === "init.mp4" ? media.init : media.media,
      })
    return route.fulfill({ status: 404 })
  })
  await page.addInitScript(() => {
    const probe = new WeakMap<HTMLVideoElement, Probe>()
    window.__syntheticStartupProbe = probe
    // Capture listeners exist before any video loadstart, including new sessions.
    const state = (video: HTMLVideoElement) => {
      let current = probe.get(video)
      if (!current) {
        current = { loadstarts: 0, played: false, waitingAfterPlaying: 0 }
        probe.set(video, current)
      }
      return current
    }
    document.addEventListener(
      "loadstart",
      (event) => {
        if (!(event.target instanceof HTMLVideoElement)) return
        const current = state(event.target)
        current.loadstarts++
        current.played = false
        current.waitingAfterPlaying = 0
      },
      true
    )
    document.addEventListener(
      "playing",
      (event) => {
        if (event.target instanceof HTMLVideoElement)
          state(event.target).played = true
      },
      true
    )
    document.addEventListener(
      "waiting",
      (event) => {
        if (!(event.target instanceof HTMLVideoElement)) return
        const current = state(event.target)
        if (current.played) current.waitingAfterPlaying++
      },
      true
    )
  })
  return { deleted, active }
}

function firstWindow(page: Page) {
  return page.getByRole("region", { name: "窗口 1", exact: true })
}

async function start(first: Locator) {
  await first.getByRole("button", { name: "开始预览", exact: true }).click()
  const video = first.locator("video")
  await expect(video).toHaveCount(1)
  return video
}

async function stop(first: Locator, deleted: string[]) {
  const before = deleted.length
  await first.getByRole("button", { name: "停止预览", exact: true }).click()
  await expect(first.locator("video")).toHaveCount(0)
  await expect.poll(() => deleted.length).toBe(before + 1)
}

async function sample(first: Locator, deleted: string[]): Promise<Sample> {
  const video = await start(first)
  try {
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => {
          const raw = element.dataset.liveStartup
          const startup: Startup | undefined = raw ? JSON.parse(raw) : undefined
          return (
            startup?.frameCallbackSupported === true &&
            startup.firstFrameMs !== null &&
            startup.firstFrameMediaSeconds !== null &&
            element.getVideoPlaybackQuality().totalVideoFrames > 3
          )
        })
      )
      .toBe(true)
    const measured = await video.evaluate(
      (element: HTMLVideoElement): Sample => {
        const startup: Startup = JSON.parse(element.dataset.liveStartup!)
        const quality = element.getVideoPlaybackQuality()
        const decoded = element as HTMLVideoElement & {
          webkitDecodedFrameCount?: number
        }
        let forwardBufferSeconds = 0
        for (let index = 0; index < element.buffered.length; index++)
          if (
            element.buffered.start(index) <= element.currentTime &&
            element.buffered.end(index) >= element.currentTime
          )
            forwardBufferSeconds =
              element.buffered.end(index) - element.currentTime
        const probe = window.__syntheticStartupProbe.get(element)!
        return {
          startup,
          decodedFrames:
            decoded.webkitDecodedFrameCount ?? quality.totalVideoFrames,
          totalFrames: quality.totalVideoFrames,
          droppedFrames: quality.droppedVideoFrames,
          forwardBufferSeconds,
          waitingAfterPlaying: probe.waitingAfterPlaying,
          loadstarts: probe.loadstarts,
        }
      }
    )
    for (const metric of [
      measured.startup.apiMs,
      measured.startup.playingMs,
      measured.startup.firstFrameMs,
      measured.startup.firstFrameMediaSeconds,
    ]) {
      expect(metric).not.toBeNull()
      expect(Number.isFinite(metric)).toBe(true)
      expect(metric).toBeGreaterThanOrEqual(0)
    }
    expect(measured.decodedFrames).toBeGreaterThan(0)
    expect(measured.totalFrames).toBeGreaterThan(3)
    expect(measured.loadstarts).toBeGreaterThan(0)
    await expect(first.getByRole("status")).toHaveCount(0)
    return measured
  } finally {
    await stop(first, deleted)
  }
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const value = (fraction: number) =>
    Number(
      sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3)
    )
  return { p50: value(0.5), p95: value(0.95) }
}

function report(codec: Codec, group: string, samples: Sample[]) {
  console.info(
    "synthetic prebuffered VOD frontend startup; not device performance",
    {
      codec,
      group,
      n: samples.length,
      failure: 0,
      apiMs: percentiles(samples.map((item) => item.startup.apiMs!)),
      playingMs: percentiles(samples.map((item) => item.startup.playingMs!)),
      firstFrameMs: percentiles(
        samples.map((item) => item.startup.firstFrameMs!)
      ),
      firstFrameMediaSeconds: percentiles(
        samples.map((item) => item.startup.firstFrameMediaSeconds!)
      ),
      forwardBufferSeconds: percentiles(
        samples.map((item) => item.forwardBufferSeconds)
      ),
      decodedFrames: samples.reduce((sum, item) => sum + item.decodedFrames, 0),
      totalFrames: samples.reduce((sum, item) => sum + item.totalFrames, 0),
      droppedFrames: samples.reduce((sum, item) => sum + item.droppedFrames, 0),
      waitingAfterPlaying: samples.reduce(
        (sum, item) => sum + item.waitingAfterPlaying,
        0
      ),
    }
  )
}

for (const codec of ["h264", "hevc"] as const)
  test(`synthetic ${codec} startup metrics on three page loads and five repeated starts`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const fixture = await prepare(page, codec)
    const coldPage: Sample[] = []
    const repeated: Sample[] = []
    const first = firstWindow(page)
    try {
      for (let round = 0; round < 3; round++) {
        if (round === 0) await page.goto("/?layout=1&slots=1:101")
        else await page.reload()
        coldPage.push(await sample(first, fixture.deleted))
      }
      for (let round = 0; round < 5; round++)
        repeated.push(await sample(first, fixture.deleted))
      expect(coldPage).toHaveLength(3)
      expect(repeated).toHaveLength(5)
      expect(fixture.active.size).toBe(0)
      report(codec, "cold-page-load-not-cold-device", coldPage)
      report(codec, "same-page-repeated-start", repeated)
    } finally {
      if (
        await first
          .getByRole("button", { name: "停止预览", exact: true })
          .isVisible()
      )
        await stop(first, fixture.deleted)
    }
  })

async function installFrameGate(page: Page) {
  await page.addInitScript(() => {
    const prototype = HTMLVideoElement.prototype
    const request = prototype.requestVideoFrameCallback
    const cancel = prototype.cancelVideoFrameCallback
    type Pending = {
      video: HTMLVideoElement
      callback: VideoFrameRequestCallback
      nativeId: number
      frame?: { now: number; metadata: VideoFrameCallbackMetadata }
      cancelled: boolean
      delivered: boolean
    }
    const pending = new Map<number, Pending>()
    let nextId = 0
    const deliver = (id: number, cancelled: boolean) => {
      const current = pending.get(id)
      if (
        !current?.frame ||
        current.delivered ||
        current.cancelled !== cancelled
      )
        return false
      current.delivered = true
      // Only replay metadata delivered by a real native video-frame callback.
      current.callback(current.frame.now, current.frame.metadata)
      return true
    }
    window.__syntheticStartupFrameGate = {
      supported: typeof request === "function" && typeof cancel === "function",
      latest(video) {
        const matches = [...pending].filter(([, item]) => item.video === video)
        return matches.at(-1)?.[0] ?? null
      },
      state(id) {
        const current = pending.get(id)
        return current
          ? {
              arrived: !!current.frame,
              cancelled: current.cancelled,
              delivered: current.delivered,
            }
          : null
      },
      release: (id) => deliver(id, false),
      late: (id) => deliver(id, true),
    }
    if (!window.__syntheticStartupFrameGate.supported) return
    prototype.requestVideoFrameCallback = function (callback) {
      const id = ++nextId
      const current: Pending = {
        video: this,
        callback,
        nativeId: 0,
        cancelled: false,
        delivered: false,
      }
      pending.set(id, current)
      current.nativeId = request.call(this, (now, metadata) => {
        current.frame = { now, metadata }
      })
      return id
    }
    prototype.cancelVideoFrameCallback = function (id) {
      const current = pending.get(id)
      if (!current) return
      current.cancelled = true
      cancel.call(this, current.nativeId)
    }
  })
}

async function heldFrame(video: Locator) {
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => {
        const raw = element.dataset.liveStartup
        const startup: Startup | undefined = raw ? JSON.parse(raw) : undefined
        const gate = window.__syntheticStartupFrameGate
        const id = gate.latest(element)
        return (
          startup?.playingMs !== null &&
          startup?.playingMs !== undefined &&
          id !== null &&
          gate.state(id)?.arrived === true
        )
      })
    )
    .toBe(true)
  return video.evaluate((element: HTMLVideoElement) =>
    window.__syntheticStartupFrameGate.latest(element)!
  )
}

async function firstFrame(video: Locator) {
  return video.evaluate(
    (element: HTMLVideoElement): number | null =>
      JSON.parse(element.dataset.liveStartup!).firstFrameMs
  )
}

test("synthetic real-frame gate preserves the spinner and isolates cancelled callbacks", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const fixture = await prepare(page, "h264")
  await installFrameGate(page)
  await page.goto("/?layout=1&slots=1:101")
  expect(
    await page.evaluate(() => window.__syntheticStartupFrameGate.supported)
  ).toBe(true)
  const first = firstWindow(page)
  try {
    const video = await start(first)
    const firstId = await heldFrame(video)
    expect(await firstFrame(video)).toBeNull()
    await expect(first.getByRole("status")).toHaveText("正在缓冲画面")
    expect(
      await page.evaluate(
        (id) => window.__syntheticStartupFrameGate.release(id),
        firstId
      )
    ).toBe(true)
    await expect.poll(() => firstFrame(video)).not.toBeNull()
    await expect(first.getByRole("status")).toHaveCount(0)
    await stop(first, fixture.deleted)

    const cancelledVideo = await start(first)
    const cancelledId = await heldFrame(cancelledVideo)
    const detached = await cancelledVideo.elementHandle()
    await stop(first, fixture.deleted)
    expect(
      await page.evaluate(
        (id) => window.__syntheticStartupFrameGate.state(id)?.cancelled,
        cancelledId
      )
    ).toBe(true)
    expect(
      await detached!.evaluate((element) => element.dataset.liveStartup)
    ).toBeUndefined()

    const current = await start(first)
    const currentId = await heldFrame(current)
    expect(await firstFrame(current)).toBeNull()
    expect(
      await page.evaluate(
        (id) => window.__syntheticStartupFrameGate.late(id),
        cancelledId
      )
    ).toBe(true)
    expect(await firstFrame(current)).toBeNull()
    expect(
      await detached!.evaluate((element) => element.dataset.liveStartup)
    ).toBeUndefined()
    await expect(first.getByRole("status")).toHaveText("正在缓冲画面")
    expect(
      await page.evaluate(
        (id) => window.__syntheticStartupFrameGate.release(id),
        currentId
      )
    ).toBe(true)
    await expect.poll(() => firstFrame(current)).not.toBeNull()
    await expect(first.getByRole("status")).toHaveCount(0)
    await stop(first, fixture.deleted)
    expect(fixture.active.size).toBe(0)
  } finally {
    if (
      await first
        .getByRole("button", { name: "停止预览", exact: true })
        .isVisible()
    )
      await stop(first, fixture.deleted)
  }
})
