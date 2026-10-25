import { chmod, mkdtemp, open, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import ts from "typescript"
import type { FragmentedMp4Demuxer } from "../../lib/media-export"
import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test"
import { selectDate, selectOption } from "./controls"

type SourceSample = {
  pts: number
  duration: number
  keyframe: boolean
  hash: string
}
type SaveObservation = {
  state?: string
  bytes?: number
  sourceBytes?: number
  durationSeconds?: number
  files?: number
  actualStartSeconds?: number
  actualEndSeconds?: number
}
type SourceAudit = {
  first?: number
  end: number
  packets: number
  samples: SourceSample[]
  audioFirst?: number
  audioEnd?: number
  audioMaxGap: number
}
type LongSaveWindow = Window & {
  __saveDeviceLatest?: SaveObservation
  __saveSourceAudit: SourceAudit
  __saveExtractFiles: File[]
}

declare const AuditedDemuxer: typeof FragmentedMp4Demuxer

// Runs inside a test-only wrapper around the actual product Worker. It keeps
// source timestamps and hashes near prospective boundaries, never source video.
function auditRecordingWorker(
  scriptURL: string,
  appOrigin: string,
  durationSeconds: number
) {
  const worker = self as unknown as {
    fetch: typeof fetch
    postMessage(value: unknown): void
    importScripts(url: string): void
  }
  const nativeFetch = worker.fetch.bind(worker)
  worker.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(String(input), appOrigin)
        : new URL(input.url)
    const response = await nativeFetch(url, init)
    if (
      url.pathname !== "/api/transfers/live" ||
      !response.ok ||
      !response.body
    )
      return response
    const reader = response.body.getReader()
    const video = new AuditedDemuxer()
    const audio = new AuditedDemuxer()
    let pending = new Uint8Array(0)
    let first: number | undefined,
      firstKeyframe: number | undefined,
      end = 0,
      packets = 0,
      auditedSamples = 0
    let audioFirst: number | undefined,
      audioEnd: number | undefined,
      audioMaxGap = 0
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              controller.close()
              return
            }
            const joined = new Uint8Array(pending.length + chunk.value.length)
            joined.set(pending)
            joined.set(chunk.value, pending.length)
            pending = joined
            const samples: SourceSample[] = []
            while (pending.length >= 5) {
              const length = new DataView(
                pending.buffer,
                pending.byteOffset
              ).getUint32(1)
              if (length > 16 * 1024 * 1024)
                throw new Error("Audit source exceeded its bounded buffer")
              if (pending.length < length + 5) break
              const kind = pending[0],
                bytes = pending.subarray(5, length + 5)
              if (kind === 1)
                for (const packet of video.push(bytes)) {
                  if (packet.kind !== "video") continue
                  first ??= packet.pts
                  if (packet.keyframe) firstKeyframe ??= packet.pts
                  end = Math.max(end, packet.pts + (packet.duration ?? 0))
                  packets++
                  if (firstKeyframe === undefined) continue
                  const relative = packet.pts - firstKeyframe
                  if (
                    relative < 0 ||
                    relative > durationSeconds + 8 ||
                    Math.abs(relative - Math.round(relative / 300) * 300) > 8
                  )
                    continue
                  if (auditedSamples >= 6000)
                    throw new Error("Audit exceeded its bounded sample count")
                  auditedSamples++
                  const digest = await crypto.subtle.digest(
                    "SHA-256",
                    packet.data.slice().buffer
                  )
                  samples.push({
                    pts: packet.pts,
                    duration: packet.duration ?? 0,
                    keyframe: packet.keyframe,
                    hash: Array.from(new Uint8Array(digest), (byte) =>
                      byte.toString(16).padStart(2, "0")
                    ).join(""),
                  })
                }
              else if (kind === 2)
                for (const packet of audio.push(bytes)) {
                  if (packet.kind !== "audio") continue
                  audioFirst ??= packet.pts
                  if (audioEnd !== undefined)
                    audioMaxGap = Math.max(audioMaxGap, packet.pts - audioEnd)
                  audioEnd = packet.pts + (packet.duration ?? 0)
                }
              pending = pending.slice(length + 5)
            }
            worker.postMessage({
              __sourceAudit: {
                first,
                end,
                packets,
                samples,
                audioFirst,
                audioEnd,
                audioMaxGap,
              },
            })
            controller.enqueue(chunk.value)
          } catch (error) {
            controller.error(error)
          }
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 }
    )
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  worker.importScripts(scriptURL)
}

function sourceAuditPrelude(durationSeconds: number) {
  const compile = (path: string) =>
    ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText
  return `const auditTypes = (() => { const exports = {}; ${compile("../../lib/media-export/types.ts")} return exports; })();
const AuditedDemuxer = (() => { const exports = {}; const require = () => auditTypes; ${compile("../../lib/media-export/mp4-demuxer.ts")} return exports.FragmentedMp4Demuxer; })();
${auditRecordingWorker.toString()}
const auditRecordingLimitSeconds = ${durationSeconds};`
}

// Explicit opt-in only. This suite reads private NVR media and never captures
// screenshots, traces, decoded frames, audio, or source URLs in test artifacts.
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  acceptDownloads: true,
})

test.describe("real NVR browser recording and streaming exports", () => {
  test.skip(
    process.env.RUN_NVR_SAVE_TESTS !== "1" &&
      process.env.RUN_NVR_LONG_SAVE_TESTS !== "1" &&
      process.env.RUN_NVR_MULTI_SAVE_TESTS !== "1",
    "Set RUN_NVR_SAVE_TESTS=1, RUN_NVR_LONG_SAVE_TESTS=1, or RUN_NVR_MULTI_SAVE_TESTS=1 for read-only LAN verification."
  )
  test.setTimeout(150_000)

  const track = process.env.NVR_TEST_TRACK ?? "101"
  const date = process.env.NVR_TEST_DATE ?? "2026-10-17"

  async function privateDirectory() {
    const path = await mkdtemp("/private/tmp/hikvision-save-device-")
    await chmod(path, 0o700)
    return path
  }

  async function installPicker(
    page: Page,
    fallback = false,
    auditPrelude?: string
  ) {
    await page.addInitScript(
      ({ fallback, auditPrelude }) => {
        const observed = window as unknown as LongSaveWindow
        observed.__saveSourceAudit = {
          end: 0,
          packets: 0,
          samples: [],
          audioMaxGap: 0,
        }
        const durations: number[] = []
        Object.defineProperty(window, "__saveDeviceDurations", {
          value: durations,
          configurable: true,
        })
        const NativeWorker = window.Worker
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            const blobURL = auditPrelude
              ? URL.createObjectURL(
                  new Blob(
                    [
                      `${auditPrelude}\nauditRecordingWorker(${JSON.stringify(String(url))}, ${JSON.stringify(location.origin)}, auditRecordingLimitSeconds);`,
                    ],
                    { type: "text/javascript" }
                  )
                )
              : undefined
            super(blobURL ?? url, blobURL ? undefined : options)
            if (blobURL) setTimeout(() => URL.revokeObjectURL(blobURL), 10000)
            this.addEventListener("message", (event) => {
              if (event.data?.__sourceAudit) {
                const update = event.data.__sourceAudit as SourceAudit
                const samples = observed.__saveSourceAudit.samples
                samples.push(...update.samples)
                observed.__saveSourceAudit = { ...update, samples }
                return
              }
              if (event.data?.patch)
                observed.__saveDeviceLatest = event.data.patch
              const duration = event.data?.patch?.durationSeconds
              if (typeof duration !== "number") return
              durations.push(duration)
              if (durations.length > 128) durations.shift()
            })
          }
        }
        Object.defineProperty(window, "showDirectoryPicker", {
          configurable: true,
          value: fallback
            ? undefined
            : async () => navigator.storage.getDirectory(),
        })
        Object.defineProperty(window, "showSaveFilePicker", {
          configurable: true,
          value: fallback
            ? undefined
            : async () => {
                const directory = await navigator.storage.getDirectory()
                return directory.getFileHandle("verification-clip.mkv", {
                  create: true,
                })
              },
        })
      },
      { fallback, auditPrelude }
    )
    page.on("dialog", (dialog) => void dialog.accept())
  }

  function observeTransfers(context: BrowserContext) {
    const active = new Set<Request>()
    let total = 0
    context.on("request", (request) => {
      if (!new URL(request.url()).pathname.startsWith("/api/transfers/")) return
      active.add(request)
      total++
    })
    context.on("requestfinished", (request) => active.delete(request))
    context.on("requestfailed", (request) => active.delete(request))
    return { active, count: () => total }
  }

  function serverChildren() {
    try {
      const port =
        new URL(process.env.TEST_BASE_URL ?? "http://localhost:3102").port ||
        "80"
      const owners = new Set(
        execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .split(/\s+/)
          .map(Number)
      )
      // comm contains process names only, never FFmpeg's credential-bearing args.
      const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
          return match
            ? [
                {
                  pid: Number(match[1]),
                  parent: Number(match[2]),
                  command: match[3],
                },
              ]
            : []
        })
      const descendants = new Set(owners)
      for (let pass = 0; pass < 10; pass++)
        for (const row of rows)
          if (descendants.has(row.parent)) descendants.add(row.pid)
      return new Set(
        rows
          .filter(
            (row) =>
              descendants.has(row.pid) && /(?:^|\/)ffmpeg$/.test(row.command)
          )
          .map((row) => row.pid)
      )
    } catch {
      throw new Error("无法取得开发服务器媒体进程统计。")
    }
  }

  async function closeAndClean(page: Page) {
    if (page.isClosed()) return
    await page
      .evaluate(() => {
        for (const button of document.querySelectorAll<HTMLButtonElement>(
          '[aria-label^="停止录制 "]'
        ))
          button.click()
      })
      .catch(() => {})
    await page.goto("/").catch(() => {})
    await page
      .evaluate(async () => {
        const directory = await navigator.storage.getDirectory()
        const entries = directory as FileSystemDirectoryHandle & {
          entries(): AsyncIterable<[string, FileSystemHandle]>
        }
        for await (const [name] of entries.entries())
          await directory.removeEntry(name, { recursive: true }).catch(() => {})
      })
      .catch(() => {})
  }

  async function extractOpfsStreaming(page: Page, directory: string) {
    const sizes = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const entries = root as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemFileHandle]>
      }
      const files: { name: string; file: File }[] = []
      for await (const [name, handle] of entries.entries()) {
        if (handle.kind !== "file") continue
        const file = await handle.getFile()
        if (file.size) files.push({ name, file })
      }
      files.sort((left, right) => left.name.localeCompare(right.name))
      ;(window as unknown as LongSaveWindow).__saveExtractFiles = files.map(
        ({ file }) => file
      )
      return files.map(({ file }) => file.size)
    })
    const paths: string[] = []
    try {
      for (const [index, size] of sizes.entries()) {
        const path = join(directory, `segment-${index + 1}.mkv`)
        const target = await open(path, "wx", 0o600)
        let written = 0
        try {
          while (written < size) {
            const chunk = await page.evaluate(
              async ({ index, offset }) => {
                const file = (window as unknown as LongSaveWindow)
                  .__saveExtractFiles[index]
                // File.stream() can return multi-megabyte chunks in Chrome.
                // Slice explicitly to bound both read and browser→Node copies.
                const bytes = await file
                  .slice(offset, offset + 256 * 1024)
                  .arrayBuffer()
                return Array.from(new Uint8Array(bytes))
              },
              { index, offset: written }
            )
            expect(chunk.length).toBeGreaterThan(0)
            expect(chunk.length).toBeLessThanOrEqual(256 * 1024)
            expect(written + chunk.length).toBeLessThanOrEqual(size)
            const bytes = Buffer.from(chunk)
            // Finish each bounded disk write before requesting the next slice.
            // No whole-file array or media Blob is built by the test.
            await target.writeFile(bytes)
            written += bytes.byteLength
          }
        } finally {
          await target.close()
        }
        expect(written).toBe(size)
        paths.push(path)
      }
    } finally {
      await page.evaluate(() => {
        ;(window as unknown as LongSaveWindow).__saveExtractFiles = []
      })
    }
    return paths
  }

  function videoTimeline(path: string) {
    let parsed: {
      packets: {
        pts_time: string
        duration_time?: string
        flags: string
        data_hash: string
      }[]
    }
    try {
      parsed = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_packets",
            "-show_entries",
            "packet=pts_time,duration_time,flags,data_hash",
            "-show_data_hash",
            "sha256",
            "-of",
            "json",
            path,
          ],
          {
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          }
        )
      )
    } catch {
      throw new Error("无法读取长录制成品的脱敏时间戳信息。")
    }
    const packets = parsed.packets
      .map((packet) => ({
        pts: Number(packet.pts_time),
        duration: Number(packet.duration_time ?? 0.04),
        keyframe: packet.flags.includes("K"),
        hash: packet.data_hash.replace(/^SHA256:/i, "").toLowerCase(),
      }))
      .sort((left, right) => left.pts - right.pts)
    expect(packets.length).toBeGreaterThan(1000)
    expect(packets[0].keyframe).toBe(true)
    expect(Math.abs(packets[0].pts)).toBeLessThanOrEqual(0.002)
    for (let at = 1; at < packets.length; at++) {
      const previous = packets[at - 1]
      expect(
        Math.abs(packets[at].pts - previous.pts - previous.duration)
      ).toBeLessThanOrEqual(0.002)
    }
    return { first: packets[0], last: packets.at(-1)! }
  }

  function audioTimeline(path: string) {
    let parsed: {
      streams: { sample_rate: string; channels: number }[]
      packets: { pts_time: string; duration_time: string; size: string }[]
    }
    try {
      parsed = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_streams",
            "-show_packets",
            "-show_entries",
            "stream=sample_rate,channels:packet=pts_time,duration_time,size",
            "-of",
            "json",
            path,
          ],
          {
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          }
        )
      )
    } catch {
      throw new Error("无法读取长录制成品的脱敏音轨时间戳信息。")
    }
    const packets = parsed.packets
      .map((packet) => ({
        pts: Number(packet.pts_time),
        duration: Number(packet.duration_time),
        bytes: Number(packet.size),
      }))
      .sort((left, right) => left.pts - right.pts)
    expect(packets.length).toBeGreaterThan(100)
    let maxGap = 0,
      maxOverlap = 0
    for (let at = 1; at < packets.length; at++) {
      const gap =
        packets[at].pts - packets[at - 1].pts - packets[at - 1].duration
      maxGap = Math.max(maxGap, gap)
      maxOverlap = Math.max(maxOverlap, -gap)
    }
    const last = packets.at(-1)!
    return {
      first: packets[0].pts,
      end: last.pts + last.duration,
      maxGap,
      maxOverlap,
      sampleSeconds:
        packets.reduce((sum, packet) => sum + packet.bytes, 0) /
        Number(parsed.streams[0].sample_rate) /
        parsed.streams[0].channels,
    }
  }

  function verifyMedia(path: string, mode: string, minimumDuration: number) {
    let info: {
      streams: {
        codec_name: string
        codec_type: string
        width?: number
        height?: number
        sample_rate?: string
        channels?: number
      }[]
      format: { duration?: string }
    }
    let duration: number
    try {
      info = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,codec_type,width,height,sample_rate,channels:format=duration",
            "-of",
            "json",
            path,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        )
      )
      duration = Number(info.format.duration)
      if (!Number.isFinite(duration)) {
        // A forward-only native download cannot seek back to patch Matroska's
        // Duration header. Verify its actual media timeline instead.
        const timeline = JSON.parse(
          execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_packets",
              "-show_entries",
              "packet=pts_time,duration_time",
              "-of",
              "json",
              path,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
          )
        ) as { packets: { pts_time?: string; duration_time?: string }[] }
        const packets = timeline.packets.flatMap((packet) => {
          const start = Number(packet.pts_time)
          if (!Number.isFinite(start)) return []
          const length = Number(packet.duration_time)
          return [
            { start, end: start + (Number.isFinite(length) ? length : 0) },
          ]
        })
        duration =
          Math.max(...packets.map((packet) => packet.end)) -
          Math.min(...packets.map((packet) => packet.start))
      }
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-xerror",
          "-i",
          path,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-f",
          "null",
          "-",
        ],
        { stdio: "ignore", timeout: 60_000 }
      )
    } catch {
      throw new Error(
        "真实录像成品的容器或音视频解码验证失败，未输出媒体内容。"
      )
    }
    const video = info.streams.find((stream) => stream.codec_type === "video")
    const audio = info.streams.find((stream) => stream.codec_type === "audio")
    expect(video).toBeDefined()
    expect(["h264", "hevc"]).toContain(video?.codec_name)
    expect(video?.width).toBeGreaterThan(0)
    expect(video?.height).toBeGreaterThan(0)
    expect(audio).toBeDefined()
    expect(["pcm_alaw", "pcm_mulaw"]).toContain(audio?.codec_name)
    expect(Number.isFinite(duration)).toBe(true)
    expect(duration).toBeGreaterThanOrEqual(minimumDuration)
    console.log(
      JSON.stringify({
        mode,
        videoCodec: video?.codec_name,
        width: video?.width,
        height: video?.height,
        durationSeconds: duration,
        audioCodec: audio?.codec_name,
        sampleRate: Number(audio?.sample_rate),
        channels: audio?.channels,
      })
    )
    return duration
  }

  async function realChannel(page: Page) {
    const response = await page.request.get("/api/channels")
    expect(response.ok()).toBe(true)
    const data = (await response.json()) as {
      channels: { id: string; name: string }[]
    }
    const channel = data.channels.find((channel) => channel.id === track)
    if (!channel) throw new Error("所选实机轨道不在设备通道列表中。")
    return {
      channel,
      others: data.channels.filter((item) => item.id !== track),
    }
  }

  async function openHistory(page: Page) {
    const { channel } = await realChannel(page)
    const response = await page.request.get(
      `/api/recordings?track=${encodeURIComponent(track)}&date=${encodeURIComponent(date)}`
    )
    expect(response.ok()).toBe(true)
    const data = (await response.json()) as {
      segments: { id: string; startAt: string; endAt: string }[]
    }
    const segmentIndex = data.segments.findIndex(
      (segment) =>
        Date.parse(segment.endAt) - Date.parse(segment.startAt) >= 10_000
    )
    if (segmentIndex < 0) throw new Error("所选日期没有可验证的真实录像片段。")
    await page.goto("/playback")
    await expect(
      page.getByRole("combobox", { name: "摄像头", exact: true })
    ).toBeEnabled()
    if (
      !(
        await page
          .getByRole("combobox", { name: "摄像头", exact: true })
          .textContent()
      )?.includes(channel.name)
    )
      await selectOption(page, "摄像头", channel.name)
    await selectDate(page, date)
    const list = page.getByRole("button", { name: "片段列表", exact: true })
    await list.click()
    await page
      .getByRole("button", {
        name: new RegExp(`^选择片段 ${segmentIndex + 1}，`),
      })
      .click()
    await list.click()
    await expect
      .poll(
        () =>
          page
            .locator("video")
            .evaluate(
              (video: HTMLVideoElement) =>
                video.getVideoPlaybackQuality().totalVideoFrames
            ),
        { timeout: 40_000, intervals: [500] }
      )
      .toBeGreaterThan(1)
    await page.getByRole("button", { name: "暂停录像", exact: true }).click()
    await page.getByRole("button", { name: "播放倍速", exact: true }).click()
    await page.getByRole("button", { name: "4×", exact: true }).click()
    await page.getByRole("button", { name: "下载片段", exact: true }).click()
    await page
      .getByRole("textbox", { name: "片段起点", exact: true })
      .fill("00:00:01")
    await page
      .getByRole("textbox", { name: "片段终点", exact: true })
      .fill("00:00:08")
  }

  async function taskPanel(page: Page) {
    const task = page.locator(".save-task-item").first()
    if (!(await task.isVisible()))
      await page
        .getByRole("button", { name: "录制与下载任务", exact: true })
        .click()
    await expect(task).toBeVisible()
    return task
  }

  test("records at least twelve seconds while changing views, then decodes the saved original audio and video", async ({
    page,
    context,
  }) => {
    test.skip(process.env.RUN_NVR_SAVE_TESTS !== "1", "Short LAN test opt-in")
    const directory = await privateDirectory()
    const baseline = serverChildren()
    const observed = observeTransfers(context)
    try {
      await installPicker(page)
      const { channel, others } = await realChannel(page)
      await page.goto("/")
      await expect(
        page.getByLabel("窗口 1 通道", { exact: true })
      ).toBeEnabled()
      if (
        !(
          await page.getByLabel("窗口 1 通道", { exact: true }).textContent()
        )?.includes(channel.name)
      )
        await selectOption(page, "窗口 1 通道", channel.name)
      await page
        .getByRole("region", { name: "窗口 1", exact: true })
        .getByRole("button", { name: `录制 ${channel.name}`, exact: true })
        .click()
      await page
        .getByRole("button", { name: "选择位置并录制", exact: true })
        .click()
      const task = await taskPanel(page)
      await expect(task).toHaveAttribute("data-state", "saving", {
        timeout: 35_000,
      })
      await page.keyboard.press("Escape")
      if (others[0]) {
        await selectOption(page, "窗口 1 通道", others[0].name)
        await expect(page.getByRole("listbox")).toHaveCount(0)
      }
      await page.getByRole("link", { name: "录像回放", exact: true }).click()
      const running = await taskPanel(page)
      const background = await context.newPage()
      await background.goto("about:blank")
      await background.bringToFront()
      const backgroundAt = Date.now()
      await expect
        .poll(
          () => observed.active.size === 1 && Date.now() - backgroundAt >= 3000,
          { timeout: 8000, intervals: [500] }
        )
        .toBe(true)
      await page.bringToFront()
      await background.close()
      // Native window blur dismisses the task popover; reopen it before
      // observing UI progress or invoking its stop button.
      await taskPanel(page)
      await expect
        .poll(
          async () => {
            const state = await running.getAttribute("data-state")
            if (
              state === "partial" ||
              state === "failed" ||
              state === "complete"
            ) {
              const message = await running
                .locator("[role=alert], [role=status]")
                .last()
                .textContent()
              throw new Error(
                `实机录制提前结束（${state}）：${message ?? "未提供原因"}`
              )
            }
            const text = await running.textContent()
            const time = /(\d{2}):(\d{2}):(\d{2})/.exec(text ?? "")
            return time
              ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
              : 0
          },
          { timeout: 40_000, intervals: [500] }
        )
        .toBeGreaterThanOrEqual(12)
      // The real camera uses a four-second GOP. Stop between GOP boundaries
      // to prove the recording transport emits its shorter 0.5-second video
      // fragments rather than silently discarding a whole buffered GOP.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const duration =
                (
                  window as unknown as { __saveDeviceDurations: number[] }
                ).__saveDeviceDurations.at(-1) ?? 0
              const remainder = duration % 4
              return duration >= 12.4 && remainder >= 0.4 && remainder <= 3.5
            }),
          { timeout: 10_000, intervals: [50] }
        )
        .toBe(true)
      const durationBeforeStop = await page.evaluate(
        () =>
          (
            window as unknown as { __saveDeviceDurations: number[] }
          ).__saveDeviceDurations.at(-1) ?? 0
      )
      await page.bringToFront()
      await running
        .getByRole("button", {
          name: `停止并保存 ${channel.name}`,
          exact: true,
        })
        .click()
      await expect(running).toHaveAttribute("data-state", "complete", {
        timeout: 20_000,
      })
      expect(observed.count()).toBe(1)
      await expect.poll(() => observed.active.size, { timeout: 10_000 }).toBe(0)
      const files = await extractOpfsStreaming(page, directory)
      expect(files).toHaveLength(1)
      const savedDuration = verifyMedia(files[0], "real-live-opfs", 12)
      expect(savedDuration).toBeGreaterThanOrEqual(durationBeforeStop - 0.1)
      expect(savedDuration % 4).toBeGreaterThan(0.2)
      await expect
        .poll(
          () =>
            [...serverChildren()].filter((pid) => !baseline.has(pid)).length,
          { timeout: 10_000 }
        )
        .toBe(0)
    } finally {
      await closeAndClean(page)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("exports a real short historical range at original speed using a native writable file", async ({
    page,
    context,
  }) => {
    test.skip(process.env.RUN_NVR_SAVE_TESTS !== "1", "Short LAN test opt-in")
    const directory = await privateDirectory()
    const baseline = serverChildren()
    const observed = observeTransfers(context)
    try {
      await installPicker(page)
      await openHistory(page)
      await page.getByRole("button", { name: "保存选区", exact: true }).click()
      await page.getByRole("button", { name: "关闭回放", exact: true }).click()
      const task = await taskPanel(page)
      await expect(task).toHaveAttribute("data-state", "complete", {
        timeout: 60_000,
      })
      await expect(task).toContainText("00:00:01 — 00:00:08，原速")
      const files = await extractOpfsStreaming(page, directory)
      expect(files).toHaveLength(1)
      const duration = verifyMedia(files[0], "real-history-opfs", 6.8)
      expect(duration).toBeLessThan(30)
      expect(observed.count()).toBe(1)
      await expect.poll(() => observed.active.size, { timeout: 10_000 }).toBe(0)
      await expect
        .poll(
          () =>
            [...serverChildren()].filter((pid) => !baseline.has(pid)).length,
          { timeout: 10_000 }
        )
        .toBe(0)
    } finally {
      await closeAndClean(page)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("streams a real historical clip through the Service Worker into the native download manager", async ({
    page,
    context,
  }) => {
    test.skip(process.env.RUN_NVR_SAVE_TESTS !== "1", "Short LAN test opt-in")
    const directory = await privateDirectory()
    const baseline = serverChildren()
    const observed = observeTransfers(context)
    try {
      await installPicker(page, true)
      await openHistory(page)
      const receiving = page.waitForEvent("download", { timeout: 40_000 })
      await page.getByRole("button", { name: "保存选区", exact: true }).click()
      const download = await receiving
      await page.getByRole("button", { name: "关闭回放", exact: true }).click()
      const task = await taskPanel(page)
      await expect(task).toHaveAttribute("data-state", "complete", {
        timeout: 60_000,
      })
      const path = join(directory, "native-download.mkv")
      await download.saveAs(path)
      await chmod(path, 0o600)
      expect(await download.failure()).toBeNull()
      const duration = verifyMedia(path, "real-history-native-download", 6.8)
      expect(duration).toBeLessThan(30)
      expect(observed.count()).toBe(1)
      await expect.poll(() => observed.active.size, { timeout: 10_000 }).toBe(0)
      await expect
        .poll(
          () =>
            [...serverChildren()].filter((pid) => !baseline.has(pid)).length,
          { timeout: 10_000 }
        )
        .toBe(0)
      await download.delete()
    } finally {
      await closeAndClean(page)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("two real channels keep recording independently when one is stopped", async ({
    page,
    context,
  }) => {
    test.skip(
      process.env.RUN_NVR_MULTI_SAVE_TESTS !== "1",
      "Set RUN_NVR_MULTI_SAVE_TESTS=1 for explicit two-channel LAN verification."
    )
    const directory = await privateDirectory()
    const baseline = serverChildren()
    const observed = observeTransfers(context)
    try {
      await installPicker(page)
      const { channel, others } = await realChannel(page)
      const secondTrack = process.env.NVR_TEST_SECOND_TRACK
      const second = secondTrack
        ? others.find((candidate) => candidate.id === secondTrack)
        : others[0]
      if (!second)
        throw new Error(
          "双路实机测试需要设备列表中另一条有效轨道；NVR_TEST_SECOND_TRACK 必须与首路不同。"
        )
      await page.goto("/")
      const activity = page.getByRole("region", {
        name: "进行中的录制与下载",
        exact: true,
      })
      const rows = activity.locator(".save-activity-item")
      const channels = [channel, second]
      for (const [index, selected] of channels.entries()) {
        const label = `窗口 ${index + 1} 通道`
        await expect(page.getByLabel(label, { exact: true })).toBeEnabled()
        if (
          !(
            await page.getByLabel(label, { exact: true }).textContent()
          )?.includes(selected.name)
        )
          await selectOption(page, label, selected.name)
        await page
          .getByRole("region", { name: `窗口 ${index + 1}`, exact: true })
          .getByRole("button", { name: `录制 ${selected.name}`, exact: true })
          .click()
        await page
          .getByRole("button", { name: "选择位置并录制", exact: true })
          .click()
        await expect(rows).toHaveCount(index + 1)
        await expect(rows.nth(index)).toHaveAttribute("data-state", "saving", {
          timeout: 35_000,
        })
      }
      await expect.poll(() => observed.active.size).toBe(2)
      const secondRequest = [...observed.active].find(
        (request) => request.postDataJSON()?.track === second.id
      )
      expect(secondRequest).toBeDefined()
      await expect
        .poll(
          async () => {
            const durations = await rows.evaluateAll((items) =>
              items.map((item) => {
                if (item.getAttribute("data-state") !== "saving")
                  throw new Error("双路实机录制未能持续保存。")
                const time = /(\d{2}):(\d{2}):(\d{2})/.exec(
                  item.querySelector(".save-activity-progress")?.textContent ??
                    ""
                )
                return time
                  ? Number(time[1]) * 3600 +
                      Number(time[2]) * 60 +
                      Number(time[3])
                  : 0
              })
            )
            return durations.length === 2 ? Math.min(...durations) : 0
          },
          { timeout: 40_000, intervals: [500] }
        )
        .toBeGreaterThanOrEqual(12)
      await page
        .getByRole("region", { name: "窗口 1", exact: true })
        .getByRole("button", { name: `停止录制 ${channel.name}`, exact: true })
        .click()
      await expect(rows).toHaveCount(1, { timeout: 20_000 })
      await expect.poll(() => observed.active.size).toBe(1)
      expect([...observed.active]).toEqual([secondRequest])
      expect(observed.count()).toBe(2)
      await expect(rows.first()).toHaveAttribute("data-state", "saving")
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as LongSaveWindow).__saveDeviceLatest?.state
          )
        )
        .toBe("saving")
      const remaining = await page.evaluate(
        () => (window as unknown as LongSaveWindow).__saveDeviceLatest!
      )
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as unknown as LongSaveWindow).__saveDeviceLatest
                  ?.bytes ?? 0
            ),
          { timeout: 10_000, intervals: [250] }
        )
        .toBeGreaterThan(remaining.bytes ?? 0)
      expect(observed.active.has(secondRequest!)).toBe(true)
      expect(observed.count()).toBe(2)
      await page
        .getByRole("region", { name: "窗口 2", exact: true })
        .getByRole("button", { name: `停止录制 ${second.name}`, exact: true })
        .click()
      await expect(activity).toBeHidden({ timeout: 20_000 })
      await expect.poll(() => observed.active.size, { timeout: 10_000 }).toBe(0)
      await taskPanel(page)
      const tasks = page.locator(".save-task-item")
      await expect(tasks).toHaveCount(2)
      for (const task of await tasks.all())
        await expect(task).toHaveAttribute("data-state", "complete")
      const files = await extractOpfsStreaming(page, directory)
      expect(files).toHaveLength(2)
      const durations = files.map((path, index) =>
        verifyMedia(path, `real-two-channel-${index + 1}`, 12)
      )
      expect(Math.max(...durations)).toBeGreaterThanOrEqual(
        (remaining.durationSeconds ?? 12) - 0.1
      )
      await expect
        .poll(
          () =>
            [...serverChildren()].filter((pid) => !baseline.has(pid)).length,
          { timeout: 10_000 }
        )
        .toBe(0)
      console.log(
        JSON.stringify({
          mode: "real-two-channel-complete",
          files: files.length,
          durationSeconds: durations,
          independentSourceRequests: observed.count(),
          activeTransfers: observed.active.size,
          remainingNewFfmpegProcesses: [...serverChildren()].filter(
            (pid) => !baseline.has(pid)
          ).length,
        })
      )
    } finally {
      await closeAndClean(page)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("fifteen-minute live recording naturally completes with continuous keyframe segments", async ({
    page,
    context,
  }) => {
    test.skip(
      process.env.RUN_NVR_LONG_SAVE_TESTS !== "1",
      "Set RUN_NVR_LONG_SAVE_TESTS=1 for a full LAN recording (NVR_LONG_SAVE_MINUTES=15|30|60; default 15)."
    )
    const requestedMinutes = process.env.NVR_LONG_SAVE_MINUTES ?? "15"
    if (!["15", "30", "60"].includes(requestedMinutes))
      throw new Error("NVR_LONG_SAVE_MINUTES must be 15, 30, or 60.")
    const minutes = Number(requestedMinutes)
    const durationSeconds = minutes * 60
    const expectedFiles = durationSeconds / 300
    // Copying high-bitrate files out of OPFS and decoding every segment can
    // outlast recording by several minutes. The recording loop below retains
    // its separate minutes + 2 deadline; this budget also covers verification.
    test.setTimeout((minutes + Math.max(10, minutes / 2)) * 60_000)
    const directory = await privateDirectory()
    const baseline = serverChildren()
    const observed = observeTransfers(context)
    try {
      await installPicker(page, false, sourceAuditPrelude(durationSeconds))
      const navigationStarted = Date.now()
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return
        console.log(
          JSON.stringify({
            mode: "long-save-main-navigation",
            elapsedSeconds: Math.round((Date.now() - navigationStarted) / 1000),
            path: new URL(frame.url()).pathname,
          })
        )
      })
      page.on("crash", () =>
        console.log(JSON.stringify({ mode: "long-save-page-crash" }))
      )
      page.on("console", (message) => {
        if (!/Fast Refresh|full reload|HMR/i.test(message.text())) return
        console.log(
          JSON.stringify({
            mode: "long-save-dev-refresh",
            elapsedSeconds: Math.round((Date.now() - navigationStarted) / 1000),
            fullReload: /full reload/i.test(message.text()),
          })
        )
      })
      const { channel } = await realChannel(page)
      await page.goto("/")
      await expect(
        page.getByLabel("窗口 1 通道", { exact: true })
      ).toBeEnabled()
      if (
        !(
          await page.getByLabel("窗口 1 通道", { exact: true }).textContent()
        )?.includes(channel.name)
      )
        await selectOption(page, "窗口 1 通道", channel.name)
      await page
        .getByRole("region", { name: "窗口 1", exact: true })
        .getByRole("button", { name: `录制 ${channel.name}`, exact: true })
        .click()
      const recordingLimit = page.getByRole("button", {
        name: `${minutes} 分钟`,
        exact: true,
      })
      await recordingLimit.click()
      await expect(recordingLimit).toHaveAttribute("aria-pressed", "true")
      const startedAt = Date.now()
      await page
        .getByRole("button", { name: "选择位置并录制", exact: true })
        .click()
      const task = await taskPanel(page)
      await expect(task).toHaveAttribute("data-state", "saving", {
        timeout: 35_000,
      })
      let lastBytes = 0
      while (true) {
        const current = await page.evaluate(
          () => (window as unknown as LongSaveWindow).__saveDeviceLatest
        )
        const sourceProgress = await page.evaluate(() => {
          const audit = (window as unknown as LongSaveWindow).__saveSourceAudit
          return {
            sourceVideoPackets: audit.packets,
            sourceAudioEndSeconds: audit.audioEnd,
            sourceAudioMaxGapSeconds: audit.audioMaxGap,
          }
        })
        console.log(
          JSON.stringify({
            mode: "real-long-live-progress",
            configuredMinutes: minutes,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            ...current,
            ...sourceProgress,
          })
        )
        if (!current)
          throw new Error(
            "长录制测试页面已重载或诊断状态丢失；请检查脱敏导航/HMR事件后重跑。"
          )
        if (current?.state === "complete") break
        expect(["preparing", "saving"]).toContain(current?.state)
        expect(observed.active.size).toBe(1)
        expect(current?.bytes ?? 0).toBeGreaterThan(lastBytes)
        lastBytes = current?.bytes ?? 0
        expect(Date.now() - startedAt).toBeLessThan((minutes + 2) * 60_000)
        await page.waitForTimeout(30_000)
      }
      await expect(task).toHaveAttribute("data-state", "complete")
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        durationSeconds * 1000
      )
      expect(observed.count()).toBe(1)
      await expect.poll(() => observed.active.size, { timeout: 10_000 }).toBe(0)
      await expect
        .poll(
          () =>
            [...serverChildren()].filter((pid) => !baseline.has(pid)).length,
          { timeout: 10_000 }
        )
        .toBe(0)
      const audit = await page.evaluate(
        () => (window as unknown as LongSaveWindow).__saveSourceAudit
      )
      expect(audit.samples.length).toBeGreaterThan(100)
      expect(audit.samples.length).toBeLessThanOrEqual(6000)
      expect(audit.audioFirst).toBeDefined()
      expect(audit.audioEnd).toBeDefined()
      expect(audit.audioMaxGap).toBeLessThanOrEqual(0.002)
      const files = await extractOpfsStreaming(page, directory)
      expect(files).toHaveLength(expectedFiles)
      let previousEnd: number | undefined,
        previousAudioEnd: number | undefined,
        initialAudioStart: number | undefined,
        initialStart: number | undefined,
        totalDuration = 0,
        totalAudioSamplesSeconds = 0
      for (const [index, path] of files.entries()) {
        const duration = verifyMedia(
          path,
          `real-long-segment-${index + 1}`,
          291.9
        )
        expect(duration).toBeLessThanOrEqual(304.1)
        if (index < expectedFiles - 1)
          expect(duration).toBeGreaterThanOrEqual(299.9)
        totalDuration += duration
        const timeline = videoTimeline(path)
        const starts = audit.samples.filter(
          (sample) => sample.hash === timeline.first.hash && sample.keyframe
        )
        expect(starts.length).toBeGreaterThan(0)
        const sourceStart = starts.sort(
          (left, right) =>
            Math.abs(left.pts - (previousEnd ?? 0)) -
            Math.abs(right.pts - (previousEnd ?? 0))
        )[0]
        if (previousEnd !== undefined)
          expect(Math.abs(sourceStart.pts - previousEnd)).toBeLessThanOrEqual(
            0.002
          )
        initialStart ??= sourceStart.pts
        const sourceLast = audit.samples.find(
          (sample) =>
            sample.hash === timeline.last.hash &&
            Math.abs(sample.pts - sourceStart.pts - timeline.last.pts) <= 0.002
        )
        expect(sourceLast).toBeDefined()
        previousEnd = sourceLast!.pts + sourceLast!.duration
        const sound = audioTimeline(path)
        const sourceAudioStart = sourceStart.pts + sound.first
        const sourceAudioEnd = sourceStart.pts + sound.end
        console.log(
          JSON.stringify({
            mode: "real-long-audio-boundary",
            segment: index + 1,
            audioStartsAtSeconds: sound.first,
            audioEndsAtSeconds: sound.end,
            internalMaxGapSeconds: sound.maxGap,
            internalMaxOverlapSeconds: sound.maxOverlap,
            previousSegmentGapSeconds:
              previousAudioEnd === undefined
                ? undefined
                : sourceAudioStart - previousAudioEnd,
            sampleSeconds: sound.sampleSeconds,
          })
        )
        expect(sound.maxGap).toBeLessThanOrEqual(0.002)
        expect(sound.maxOverlap).toBeLessThanOrEqual(0.002)
        expect(Math.abs(sound.end - duration)).toBeLessThanOrEqual(0.002)
        if (previousAudioEnd !== undefined)
          expect(
            Math.abs(sourceAudioStart - previousAudioEnd)
          ).toBeLessThanOrEqual(0.002)
        else
          expect(
            Math.abs(
              sourceAudioStart - Math.max(sourceStart.pts, audit.audioFirst!)
            )
          ).toBeLessThanOrEqual(0.002)
        initialAudioStart ??= sourceAudioStart
        previousAudioEnd = sourceAudioEnd
        totalAudioSamplesSeconds += sound.sampleSeconds
      }
      expect(totalDuration).toBeGreaterThanOrEqual(durationSeconds - 0.1)
      expect(totalDuration).toBeLessThanOrEqual(durationSeconds + 4.1)
      expect(
        Math.abs(previousEnd! - initialStart! - totalDuration)
      ).toBeLessThan(0.01)
      expect(
        Math.abs(
          previousAudioEnd! - initialAudioStart! - totalAudioSamplesSeconds
        )
      ).toBeLessThanOrEqual(0.01)
      console.log(
        JSON.stringify({
          mode: "real-long-live-complete",
          configuredMinutes: minutes,
          wallSeconds: (Date.now() - startedAt) / 1000,
          files: files.length,
          totalDurationSeconds: totalDuration,
          sourceCoveredSeconds: previousEnd! - initialStart!,
          sourceVideoPackets: audit.packets,
          totalAudioSamplesSeconds,
          audioContinuityToleranceSeconds: 0.002,
          segmentContinuityToleranceSeconds: 0.002,
          activeTransfers: observed.active.size,
          remainingNewFfmpegProcesses: [...serverChildren()].filter(
            (pid) => !baseline.has(pid)
          ).length,
        })
      )
    } finally {
      await closeAndClean(page)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
