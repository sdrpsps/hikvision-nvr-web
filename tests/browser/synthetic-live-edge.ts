import { execFileSync, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { readNvrConfig } from "../../server/config"
import { LiveSessions } from "../../server/live"
import { mp4Boxes, splitFragmentedMp4 } from "../../server/mp4"
import { FragmentedMp4Demuxer } from "../../lib/media-export"

export type EdgeObservation = {
  videoBuffers: number
  waiting: number
  hiddenEvents: number
  visibleEvents: number
  firstFrame: null | {
    atMs: number
    mediaTime: number
    timestampOffset: number
  }
}

export async function observeSyntheticEdge(page: Page) {
  await page.addInitScript(() => {
    const observation: EdgeObservation = {
      videoBuffers: 0,
      waiting: 0,
      hiddenEvents: 0,
      visibleEvents: 0,
      firstFrame: null,
    }
    Object.defineProperty(window, "syntheticEdgeObservation", {
      value: observation,
    })
    let videoBuffer: SourceBuffer | undefined
    const addSourceBuffer = MediaSource.prototype.addSourceBuffer
    MediaSource.prototype.addSourceBuffer = function (type) {
      const buffer = addSourceBuffer.call(this, type)
      if (type.startsWith("video/")) {
        videoBuffer = buffer
        observation.videoBuffers++
      }
      return buffer
    }
    document.addEventListener(
      "waiting",
      (event) => {
        if (event.target instanceof HTMLVideoElement) observation.waiting++
      },
      true
    )
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") observation.hiddenEvents++
      else if (document.visibilityState === "visible")
        observation.visibleEvents++
    })
    new MutationObserver((mutations) => {
      if (observation.firstFrame) return
      for (const mutation of mutations) {
        const video = mutation.target
        if (!(video instanceof HTMLVideoElement)) continue
        const startup = JSON.parse(video.dataset.liveStartup ?? "null") as {
          firstFrameMs: number | null
          firstFrameMediaSeconds: number | null
        } | null
        if (
          startup?.firstFrameMs !== null &&
          typeof startup?.firstFrameMediaSeconds === "number" &&
          videoBuffer
        ) {
          observation.firstFrame = {
            atMs: Date.now(),
            mediaTime: startup.firstFrameMediaSeconds,
            // Observe the actual MSE mapping without touching media payloads.
            timestampOffset: videoBuffer.timestampOffset,
          }
          return
        }
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-live-startup"],
    })
  })
}

export async function syntheticLiveEdge(page: Page, codec: "h264" | "hevc") {
  const bytes = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-stream_loop",
      "19",
      "-i",
      new URL(
        `../../fixtures/${codec === "h264" ? "synthetic-preview.mp4" : "synthetic-preview-hevc.mp4"}`,
        import.meta.url
      ).pathname,
      "-t",
      "60",
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
    { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }
  )
  const boxes = mp4Boxes(bytes)
  const init = bytes.subarray(
    0,
    boxes.find((box) => box.type === "moof")!.start
  )
  const fragments: Buffer[] = []
  let moof: Buffer | undefined
  for (const box of boxes) {
    if (box.type === "moof") moof = bytes.subarray(box.start, box.end)
    else if (box.type === "mdat") {
      fragments.push(Buffer.concat([moof!, bytes.subarray(box.start, box.end)]))
      moof = undefined
    }
  }
  const media = fragments.map((fragment) =>
    splitFragmentedMp4(Buffer.concat([init, fragment]))
  )
  expect(media).toHaveLength(120)
  expect(media.every((item) => item.decodeDurationSeconds === 0.5)).toBe(true)
  expect(media.slice(0, 12).map((item) => item.startsWithKeyframe)).toEqual([
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
  if (codec === "hevc") {
    const parser = new FragmentedMp4Demuxer()
    parser.push(init)
    expect(
      parser.push(fragments[0]).some((packet) => packet.pts !== packet.dts)
    ).toBe(true)
  }
  const active = new Set<EventEmitter>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const networkTimers = new Set<ReturnType<typeof setTimeout>>()
  const created: Awaited<ReturnType<LiveSessions["create"]>>[] = []
  const deleted: string[] = []
  const edges: { atMs: number; decodeEnd: number }[] = []
  const config = readNvrConfig({
    NVR_HOST: "synthetic.test",
    NVR_USERNAME: "synthetic-user",
    NVR_PASSWORD: "synthetic-password",
  })
  let launches = 0
  let firstPlaylist: { decodeStart: number; decodeEnd: number } | undefined
  const gates = new Set<ReturnType<typeof holdFragments>>()
  let fragmentGate: ReturnType<typeof holdFragments> | undefined
  function holdFragments() {
    let released = false
    let blockedRequests = 0
    let startedAt: number | undefined
    let releasedAt: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const waiting = new Set<() => void>()
    const release = () => {
      if (released) return
      released = true
      releasedAt = Date.now()
      if (timer) {
        clearTimeout(timer)
        networkTimers.delete(timer)
      }
      for (const resolve of waiting) resolve()
      waiting.clear()
      gates.delete(gate)
      if (fragmentGate === gate) fragmentGate = undefined
    }
    const gate = {
      async wait() {
        if (released) return
        blockedRequests++
        if (startedAt === undefined) {
          startedAt = Date.now()
          // Absolute upper bound even when the test fails while a route waits.
          timer = setTimeout(release, 8000)
          timer.unref()
          networkTimers.add(timer)
        }
        await new Promise<void>((resolve) => waiting.add(resolve))
      },
      release,
      blockedRequests: () => blockedRequests,
      pending: () => waiting.size,
      released: () => released,
      durationMs: () =>
        startedAt === undefined ? 0 : (releasedAt ?? Date.now()) - startedAt,
    }
    gates.add(gate)
    fragmentGate = gate
    return gate
  }
  const sessions = new LiveSessions(() => {
    launches++
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const audio = new PassThrough()
    let at = 0
    const stopTimer = () => {
      clearInterval(timer)
      timers.delete(timer)
    }
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdio: [null, stdout, stderr, audio],
      kill() {
        if (!active.delete(child)) return true
        stopTimer()
        stdout.end()
        stderr.end()
        audio.end()
        child.emit("close", 0)
        return true
      },
    })
    const feed = () => {
      if (at >= fragments.length) {
        stopTimer()
        return
      }
      stdout.write(fragments[at])
      const fragment = media[at++]
      edges.push({
        atMs: Date.now(),
        decodeEnd: fragment.decodeStartSeconds + fragment.decodeDurationSeconds,
      })
    }
    const timer = setInterval(feed, 500)
    timer.unref()
    timers.add(timer)
    active.add(child)
    queueMicrotask(() => {
      stdout.write(init)
      // Join a source already running for fifteen seconds, not a fresh window.
      for (let count = 0; count < 30; count++) feed()
    })
    return child as unknown as ChildProcess
  }, 50_000)

  await page.context().route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === "GET" && path === "/api/channels")
      return route.fulfill({
        json: {
          timeZone: "Asia/Shanghai",
          today: "2026-10-30",
          channels: [{ id: "101", name: "合成通道", configuredEnabled: true }],
        },
      })
    if (request.method() === "POST" && path === "/api/streams/live") {
      expect(request.postDataJSON()).toEqual({ track: "101" })
      const session = await sessions.create(
        config,
        async () => "101",
        new AbortController().signal
      )
      created.push(session)
      return route.fulfill({ status: 201, json: session })
    }
    const match = /^\/api\/streams\/([a-f0-9-]{36})(?:\/([^/]+))?$/.exec(path)
    if (match) {
      const [, id, asset] = match
      if (request.method() === "DELETE" && !asset) {
        sessions.delete(id)
        deleted.push(id)
        return route.fulfill({ status: 204 })
      }
      if (request.method() === "GET" && asset) {
        try {
          if (asset === "index.m3u8") {
            const playlist = sessions.playlist(id)
            if (!firstPlaylist) {
              const names = [...playlist.matchAll(/^([0-9]+\.m4s)$/gm)].map(
                (entry) => entry[1]
              )
              const first = splitFragmentedMp4(
                Buffer.concat([init, sessions.asset(id, names[0])])
              )
              const last = splitFragmentedMp4(
                Buffer.concat([init, sessions.asset(id, names.at(-1)!)])
              )
              firstPlaylist = {
                decodeStart: first.decodeStartSeconds,
                decodeEnd: last.decodeStartSeconds + last.decodeDurationSeconds,
              }
            }
            return route.fulfill({
              contentType: "application/vnd.apple.mpegurl",
              body: playlist,
            })
          }
          const body = sessions.asset(id, asset)
          if (/^\d+\.m4s$/.test(asset)) await fragmentGate?.wait()
          return route.fulfill({
            contentType:
              asset === "init.mp4" ? "video/mp4" : "video/iso.segment",
            body,
          })
        } catch {
          return route.fulfill({ status: 404 })
        }
      }
    }
    // No API request can fall through to the configured device service.
    return route.fulfill({ status: 404 })
  })
  return {
    active,
    timers,
    networkTimers,
    created,
    deleted,
    edges,
    sessions,
    holdFragments,
    pendingFragments: () =>
      [...gates].reduce((count, gate) => count + gate.pending(), 0),
    launches: () => launches,
    firstPlaylist: () => firstPlaylist,
    latestEdge: () => edges.at(-1)!.decodeEnd,
    dispose() {
      for (const gate of gates) gate.release()
      fragmentGate = undefined
      for (const timer of networkTimers) clearTimeout(timer)
      networkTimers.clear()
      sessions.dispose()
      for (const timer of timers) clearInterval(timer)
      timers.clear()
    },
  }
}
