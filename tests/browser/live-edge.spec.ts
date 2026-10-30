import { test, expect, type Page } from "@playwright/test"
import {
  observeSyntheticEdge,
  syntheticLiveEdge,
  type EdgeObservation,
} from "./synthetic-live-edge"

test.use({ serviceWorkers: "block" })

for (const codec of ["h264", "hevc"] as const)
  test(`synthetic ${codec} joins the live edge and recovers behind it without reconnecting`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await observeSyntheticEdge(page)
    const source = await syntheticLiveEdge(page, codec)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.name))
    let background: Page | undefined
    try {
      await page.goto("/?layout=1")
      const first = page.getByRole("region", { name: "窗口 1", exact: true })
      await first.getByRole("button", { name: "开始预览", exact: true }).click()
      const video = first.locator("video")
      await expect
        .poll(() =>
          video.evaluate((element) => {
            const startup = JSON.parse(element.dataset.liveStartup ?? "null")
            return typeof startup?.firstFrameMs === "number"
          })
        )
        .toBe(true)
      const observation = await page.evaluate(
        () =>
          (
            window as unknown as {
              syntheticEdgeObservation: EdgeObservation
            }
          ).syntheticEdgeObservation
      )
      expect(observation.videoBuffers).toBe(1)
      expect(observation.firstFrame).not.toBeNull()
      const firstFrame = observation.firstFrame!
      const initial = source.firstPlaylist()!
      const target = source.created[0].targetDurationSeconds!
      expect(target).toBe(1)
      expect(initial.decodeStart).toBeGreaterThan(0)
      expect(initial.decodeEnd - initial.decodeStart).toBeGreaterThanOrEqual(12)
      // hls.js maps the first playlist's decode origin to zero through MSE.
      // Verify that mapping before comparing raw fMP4 and browser media clocks.
      expect(initial.decodeStart + firstFrame.timestampOffset).toBeCloseTo(0, 4)
      const edgeAtFrame = source.edges.findLast(
        (edge) => edge.atMs <= firstFrame.atMs
      )!.decodeEnd
      const firstLag =
        edgeAtFrame + firstFrame.timestampOffset - firstFrame.mediaTime
      expect(firstLag).toBeGreaterThanOrEqual(-0.5)
      expect(firstLag).toBeLessThanOrEqual(6 * target + 0.75)
      expect(firstFrame.mediaTime).toBeGreaterThanOrEqual(
        initial.decodeStart + firstFrame.timestampOffset + 6 * target - 1e-6
      )
      await expect(first.getByRole("status")).toHaveCount(0)

      const sample = () =>
        video.evaluate((element: HTMLVideoElement) => {
          const quality = element.getVideoPlaybackQuality()
          const observation = (
            window as unknown as {
              syntheticEdgeObservation: EdgeObservation
            }
          ).syntheticEdgeObservation
          let start = NaN
          let forward = 0
          for (let index = 0; index < element.buffered.length; index++) {
            const from = element.buffered.start(index)
            const to = element.buffered.end(index)
            if (element.currentTime >= from && element.currentTime < to) {
              start = from
              forward = to - element.currentTime
            }
          }
          return {
            currentTime: element.currentTime,
            bufferedStart: start,
            forwardBuffer: forward,
            frames: quality.totalVideoFrames - quality.droppedVideoFrames,
            dropped: quality.droppedVideoFrames,
            waiting: observation.waiting,
            hiddenEvents: observation.hiddenEvents,
            visibleEvents: observation.visibleEvents,
          }
        })
      await expect
        .poll(
          async () => {
            const value = await sample()
            return (
              value.currentTime - value.bufferedStart > 6.5 * target &&
              source.latestEdge() +
                firstFrame.timestampOffset -
                value.bufferedStart >
                8 * target
            )
          },
          { timeout: 15_000 }
        )
        .toBe(true)
      const before = await sample()
      const rewound = await video.evaluate((element: HTMLVideoElement) => {
        const target = element.buffered.start(0) + 0.25
        element.currentTime = target
        return element.currentTime
      })
      const inducedLag =
        source.latestEdge() + firstFrame.timestampOffset - rewound
      expect(inducedLag).toBeGreaterThan(6 * target + 0.5)
      await expect
        .poll(
          async () => {
            const value = await sample()
            const lag =
              source.latestEdge() +
              firstFrame.timestampOffset -
              value.currentTime
            return value.frames > before.frames + 6 && lag <= 6 * target + 0.75
          },
          { timeout: 12_000 }
        )
        .toBe(true)
      const recovered = await sample()
      expect(recovered.forwardBuffer).toBeGreaterThan(0)
      const recoveredLag =
        source.latestEdge() + firstFrame.timestampOffset - recovered.currentTime

      const beforeStall = await sample()
      const beforeStallEdge = source.latestEdge()
      const gate = source.holdFragments()
      let waitingDuringStall = 0
      try {
        await expect.poll(() => gate.blockedRequests()).toBeGreaterThan(0)
        await expect
          .poll(async () => (await sample()).waiting, { timeout: 9500 })
          .toBeGreaterThan(beforeStall.waiting)
        expect(gate.released()).toBe(false)
        expect(gate.pending()).toBeGreaterThan(0)
        waitingDuringStall = (await sample()).waiting - beforeStall.waiting
        // Keep the real media request blocked for the full bounded 8 seconds.
        await expect.poll(() => gate.released(), { timeout: 9500 }).toBe(true)
      } finally {
        gate.release()
      }
      expect(gate.durationMs()).toBeGreaterThanOrEqual(7900)
      expect(waitingDuringStall).toBeGreaterThan(0)
      expect(source.latestEdge() - beforeStallEdge).toBeGreaterThanOrEqual(7)
      const atRelease = await sample()
      await expect
        .poll(
          async () => {
            const value = await sample()
            const lag =
              source.latestEdge() +
              firstFrame.timestampOffset -
              value.currentTime
            return (
              value.frames > atRelease.frames + 6 && lag <= 6 * target + 0.75
            )
          },
          { timeout: 12_000 }
        )
        .toBe(true)
      const networkRecovered = await sample()
      const networkRecoveredLag =
        source.latestEdge() +
        firstFrame.timestampOffset -
        networkRecovered.currentTime

      const backgroundMetrics = {
        backgroundVerified: false,
        foregroundRecoveredMediaEdgeLagSeconds: null as number | null,
        presentedFramesAfterForegroundRecovery: null as number | null,
        hiddenEvents: null as number | null,
        visibleEvents: null as number | null,
      }
      if (process.env.VERIFY_LIVE_BACKGROUND !== "1") {
        test.info().annotations.push({
          type: "background-not-verified",
          description:
            "Playwright forces active-page focus, including in headed Chrome. VERIFY_LIVE_BACKGROUND=1 requires a harness without that override; this phase is not verified by default. No visibility events are spoofed.",
        })
      } else {
        // Require real hidden/visible transitions, never a synthetic event.
        background = await page.context().newPage()
        await background.goto("about:blank")
        await background.bringToFront()
        await expect
          .poll(() => page.evaluate(() => document.visibilityState))
          .toBe("hidden")
        const hiddenEdge = source.latestEdge()
        await expect
          .poll(() => source.latestEdge(), { timeout: 9500 })
          .toBeGreaterThanOrEqual(hiddenEdge + 7)
        const beforeForeground = await sample()
        await page.bringToFront()
        await expect
          .poll(() => page.evaluate(() => document.visibilityState))
          .toBe("visible")
        await expect
          .poll(
            async () => {
              const value = await sample()
              const lag =
                source.latestEdge() +
                firstFrame.timestampOffset -
                value.currentTime
              return (
                value.frames > beforeForeground.frames + 6 &&
                lag <= 6 * target + 0.75
              )
            },
            { timeout: 12_000 }
          )
          .toBe(true)
        const foregroundRecovered = await sample()
        expect(foregroundRecovered.hiddenEvents).toBeGreaterThan(
          networkRecovered.hiddenEvents
        )
        expect(foregroundRecovered.visibleEvents).toBeGreaterThan(
          networkRecovered.visibleEvents
        )
        Object.assign(backgroundMetrics, {
          backgroundVerified: true,
          foregroundRecoveredMediaEdgeLagSeconds:
            source.latestEdge() +
            firstFrame.timestampOffset -
            foregroundRecovered.currentTime,
          presentedFramesAfterForegroundRecovery:
            foregroundRecovered.frames - beforeForeground.frames,
          hiddenEvents: foregroundRecovered.hiddenEvents,
          visibleEvents: foregroundRecovered.visibleEvents,
        })
        await background.close()
        background = undefined
      }
      const final = await sample()
      expect(source.created).toHaveLength(1)
      expect(source.launches()).toBe(1)
      expect(source.deleted).toEqual([])
      expect(errors).toEqual([])
      await expect(
        page.locator('[data-sonner-toast][data-type="error"]')
      ).toHaveCount(0)
      await first.getByRole("button", { name: "停止预览", exact: true }).click()
      await expect.poll(() => source.deleted).toEqual([source.created[0].id])
      expect(source.active.size).toBe(0)
      expect(source.timers.size).toBe(0)
      expect(source.networkTimers.size).toBe(0)
      expect(source.pendingFragments()).toBe(0)
      expect(source.sessions.has(source.created[0].id)).toBe(false)
      console.info(
        JSON.stringify({
          targetDurationSeconds: target,
          firstFrameMediaSeconds: firstFrame.mediaTime,
          firstFrameMediaEdgeLagSeconds: firstLag,
          inducedMediaEdgeLagSeconds: inducedLag,
          recoveredMediaEdgeLagSeconds: recoveredLag,
          heldFragmentRequests: gate.blockedRequests(),
          fragmentStallMs: gate.durationMs(),
          waitingDuringStall,
          networkRecoveredMediaEdgeLagSeconds: networkRecoveredLag,
          presentedFramesAfterNetworkRecovery:
            networkRecovered.frames - atRelease.frames,
          ...backgroundMetrics,
          waitingEvents: final.waiting,
          presentedFrames: final.frames,
          droppedFrames: final.dropped,
          forwardBufferSeconds: final.forwardBuffer,
          activeChildrenAfterStop: source.active.size,
          feedTimersAfterStop: source.timers.size,
          networkTimersAfterStop: source.networkTimers.size,
          pendingFragmentsAfterStop: source.pendingFragments(),
        })
      )
    } finally {
      source.dispose()
      await background?.close()
    }
  })
