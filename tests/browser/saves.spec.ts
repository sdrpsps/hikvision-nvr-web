import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { createServer, type Server, type ServerResponse } from "node:http"
import { execFileSync } from "node:child_process"
import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test"
import { selectOption } from "./controls"
import { splitFragmentedMp4, mp4Boxes } from "../../server/mp4"
import {
  FragmentedMp4Demuxer,
  type EncodedPacket,
} from "../../lib/media-export"

const videoFiles = {
  h264: readFileSync(
    new URL("../../fixtures/synthetic-preview.mp4", import.meta.url)
  ),
  hevc: readFileSync(
    new URL("../../fixtures/synthetic-preview-hevc.mp4", import.meta.url)
  ),
}
const audioFile = readFileSync(
  new URL("../../fixtures/synthetic-g711-audio.mov", import.meta.url)
)
const audioTop = mp4Boxes(audioFile)
const audioFirstEnd = audioTop.find((box) => box.type === "mdat")!.end
const id = "11111111-1111-4111-8111-111111111111"
const segmentId = "a".repeat(32)
const servers: Server[] = []

test.afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function frame(kind: number, bytes: Buffer) {
  const header = Buffer.alloc(5)
  header[0] = kind
  header.writeUInt32BE(bytes.length, 1)
  return Buffer.concat([header, bytes])
}

function audioOnVideoClock(video: Buffer) {
  const videoStart = new FragmentedMp4Demuxer().push(video)[0].pts
  const audioStart = new FragmentedMp4Demuxer().push(audioFile)[0].pts
  const result = Buffer.from(audioFile)
  const top = mp4Boxes(result)
  const moov = top.find((box) => box.type === "moov")!
  const trak = mp4Boxes(moov.data).find((box) => box.type === "trak")!
  const mdia = mp4Boxes(trak.data).find((box) => box.type === "mdia")!
  const mdhd = mp4Boxes(mdia.data).find((box) => box.type === "mdhd")!
  const timescale = mdhd.data.readUInt32BE(mdhd.data[0] === 1 ? 20 : 12)
  const offset = Math.round((videoStart - audioStart) * timescale)
  // These independently generated fixtures share a three-second duration but
  // HEVC has a 1/6s composition offset for B frames. Put both tracks on the
  // same presentation clock without changing their payloads or video timing.
  for (const moof of top.filter((box) => box.type === "moof"))
    for (const traf of mp4Boxes(moof.data).filter(
      (box) => box.type === "traf"
    )) {
      const tfdt = mp4Boxes(traf.data).find((box) => box.type === "tfdt")!
      if (tfdt.data[0] === 1)
        tfdt.data.writeBigUInt64BE(
          tfdt.data.readBigUInt64BE(4) + BigInt(offset),
          4
        )
      else tfdt.data.writeUInt32BE(tfdt.data.readUInt32BE(4) + offset, 4)
    }
  return result
}

function pts(value: number) {
  const stamp = Math.round(value * 90000)
  return Buffer.from([
    0x21 | ((Math.floor(stamp / 0x40000000) & 7) << 1),
    Math.floor(stamp / 0x400000) & 255,
    ((Math.floor(stamp / 0x8000) & 127) << 1) | 1,
    Math.floor(stamp / 128) & 255,
    ((stamp & 127) << 1) | 1,
  ])
}
function pes(stream: number, packet: EncodedPacket, payload: Buffer) {
  const data = Buffer.concat([
    Buffer.from([0x80, 0x80, 5]),
    pts(packet.pts),
    payload,
  ])
  const header = Buffer.from([
    0,
    0,
    1,
    stream,
    data.length >>> 8,
    data.length & 255,
  ])
  return Buffer.concat([header, data])
}
function syntheticPs() {
  const video = new FragmentedMp4Demuxer().push(videoFiles.h264)
  const audio = new FragmentedMp4Demuxer().push(audioFile)
  const config = video[0].video!.codecPrivate
  const parameterSets: Buffer[] = []
  let at = 6
  const readSets = (count: number) => {
    for (let i = 0; i < count; i++) {
      const size = config[at] * 256 + config[at + 1]
      at += 2
      parameterSets.push(
        Buffer.from([0, 0, 0, 1]),
        Buffer.from(config.subarray(at, at + size))
      )
      at += size
    }
  }
  readSets(config[5] & 31)
  readSets(config[at++])
  const mapData = Buffer.from([
    0xe0, 0xff, 0, 0, 0, 8, 0x1b, 0xe0, 0, 0, 0x90, 0xc0, 0, 0, 0, 0, 0, 0,
  ])
  const result = [
    Buffer.from([73, 77, 75, 72, ...new Array(36).fill(0)]),
    Buffer.from([0, 0, 1, 0xbc, 0, mapData.length]),
    mapData,
  ]
  for (const packet of [...video, ...audio].sort(
    (a, b) => a.pts - b.pts || (a.kind === "video" ? -1 : 1)
  )) {
    if (packet.kind === "audio")
      result.push(pes(0xc0, packet, Buffer.from(packet.data)))
    else {
      const nals: Buffer[] = packet.keyframe ? [...parameterSets] : []
      for (let offset = 0; offset < packet.data.length;) {
        const length = new DataView(
          packet.data.buffer,
          packet.data.byteOffset + offset,
          4
        ).getUint32(0)
        offset += 4
        nals.push(
          Buffer.from([0, 0, 0, 1]),
          Buffer.from(packet.data.subarray(offset, offset + length))
        )
        offset += length
      }
      result.push(pes(0xe0, packet, Buffer.concat(nals)))
    }
  }
  return Buffer.concat(result)
}
const psFile = syntheticPs()

async function syntheticSource(
  context: BrowserContext,
  codec: "h264" | "hevc" = "h264",
  historyHold?: Promise<void>
) {
  const liveAudio =
    codec === "hevc" ? audioOnVideoClock(videoFiles.hevc) : audioFile
  const requests: { path: string; body: unknown }[] = []
  const open = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
      })
      response.writeHead(200, {
        "Content-Type":
          request.url === "/history"
            ? "application/octet-stream"
            : "application/vnd.nvr.media-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      })
      if (request.url === "/history") {
        if (historyHold) {
          // Keep a fully synthetic download in flight while its progress UI
          // is inspected, without timing assumptions or reading device media.
          response.write(psFile)
          void historyHold.then(() => response.end())
          return
        }
        response.end(psFile)
        return
      }
      open.add(response)
      response.on("close", () => open.delete(response))
      // Interleave the pipes just as the real FFmpeg bridge does, then keep the
      // connection open until the browser stops the recording.
      response.write(frame(2, liveAudio.subarray(0, audioFirstEnd)))
      const videoTimer = setTimeout(
        () => response.write(frame(1, videoFiles[codec])),
        650
      )
      const audioTimer = setTimeout(
        () => response.write(frame(2, liveAudio.subarray(audioFirstEnd))),
        1200
      )
      response.on("close", () => {
        clearTimeout(videoTimer)
        clearTimeout(audioTimer)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("synthetic stream did not start")
  await context.route("**/api/transfers/*", (route) =>
    route.continue({
      url: `http://127.0.0.1:${address.port}/${new URL(route.request().url()).pathname.split("/").at(-1)}`,
    })
  )
  return { requests, open }
}

async function queries(page: Page, fullDuration = 3) {
  await page.route("**/api/channels", (route) =>
    route.fulfill({
      json: {
        timeZone: "Asia/Shanghai",
        today: "2026-10-17",
        channels: [1, 2, 3, 4].map((n) => ({
          id: String(n * 100 + 1),
          name: `摄像头 ${n}`,
          configuredEnabled: true,
        })),
      },
    })
  )
  await page.route("**/api/recordings?**", (route) =>
    route.fulfill({
      json: {
        trackId: "101",
        date: "2026-10-17",
        timeZone: "Asia/Shanghai",
        range: {
          startAt: "2026-10-16T16:00:00Z",
          endAt: "2026-10-17T16:00:00Z",
        },
        segments: [
          {
            id: segmentId,
            startAt: "2026-10-16T16:00:00Z",
            endAt: "2026-10-16T17:00:00Z",
          },
        ],
        coverage: [],
        gaps: [],
        warnings: [],
      },
    })
  )
  const deleted: string[] = []
  const media = splitFragmentedMp4(videoFiles.h264)
  await page.route("**/api/streams/**", (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname
    if (req.method() === "POST")
      return route.fulfill({
        status: 201,
        json: {
          id,
          playlistUrl: `/api/streams/${id}/index.m3u8`,
          durationSeconds: fullDuration,
          totalDurationSeconds: fullDuration,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          mode: "stream-copy",
          codec: "h264",
        },
      })
    if (req.method() === "DELETE") {
      deleted.push(path)
      return route.fulfill({ status: 204 })
    }
    if (path.endsWith("status"))
      return route.fulfill({
        json: {
          complete: true,
          durationSeconds: fullDuration,
          totalDurationSeconds: fullDuration,
        },
      })
    if (path.endsWith("audio"))
      return route.fulfill({
        json: { status: "unsupported", videoStartSeconds: 0, chunks: [] },
      })
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
  return deleted
}

async function opfsPicker(page: Page, cancel = false) {
  await page.addInitScript((cancel) => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        if (cancel) throw new DOMException("用户取消保存", "AbortError")
        return navigator.storage.getDirectory()
      },
    })
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => {
        if (cancel) throw new DOMException("用户取消保存", "AbortError")
        const directory = await navigator.storage.getDirectory()
        return directory.getFileHandle("selected-clip.mkv", { create: true })
      },
    })
  }, cancel)
}

async function savedFiles(page: Page, info: TestInfo) {
  const files = await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory()
    const iterable = directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterable<[string, FileSystemFileHandle]>
    }
    const result: { name: string; bytes: number[] }[] = []
    for await (const [name, handle] of iterable.entries()) {
      if (handle.kind !== "file") continue
      const file = await handle.getFile()
      if (file.size)
        result.push({
          name,
          bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
        })
    }
    return result
  })
  const outputs: {
    name: string
    path: string
    info: {
      streams: { codec_name: string; codec_type: string }[]
      format: { duration: string }
    }
  }[] = []
  for (const [index, file] of files.entries()) {
    const path = info.outputPath(`saved-${index}.mkv`)
    await writeFile(path, Buffer.from(file.bytes))
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        { encoding: "utf8" }
      )
    )
    execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"], {
      encoding: "utf8",
    })
    outputs.push({ name: file.name, path, info: probe })
  }
  return outputs
}

async function startRecording(page: Page, camera = "摄像头 1") {
  await page
    .getByRole("button", { name: `录制 ${camera}`, exact: true })
    .first()
    .click()
  await page
    .getByRole("button", { name: "选择位置并录制", exact: true })
    .click()
  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "saving",
    { timeout: 20000 }
  )
  await expect(page.locator(".save-task-item")).toContainText("含原始声音")
  await page.keyboard.press("Escape")
}

for (const phase of ["startup", "stop"] as const)
  test(`an unresponsive recording worker fails within the ${phase} deadline and releases the task`, async ({
    page,
  }) => {
    await queries(page)
    await opfsPicker(page)
    let mediaRequests = 0
    await page.route("**/api/transfers/*", (route) => {
      mediaRequests++
      return route.abort()
    })
    await page.addInitScript((phase) => {
      const state = window as unknown as { saveWatchdogTerminations: number }
      state.saveWatchdogTerminations = 0
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        postMessage(message: { type?: string }) {
          // Reproduce a thread that never accepts start, or accepts it but
          // becomes unresponsive before stop can finish. No media is fetched.
          if (message.type === "start" && phase === "stop")
            queueMicrotask(() =>
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: { type: "ready", patch: {} },
                })
              )
            )
        }
        terminate() {
          state.saveWatchdogTerminations++
          super.terminate()
        }
      }
    }, phase)
    await page.goto("/")
    await page.clock.install()
    await page
      .getByRole("button", { name: "录制 摄像头 1", exact: true })
      .first()
      .click()
    await page
      .getByRole("button", { name: "选择位置并录制", exact: true })
      .click()
    await page.getByRole("button", { name: "录制与下载任务" }).click()
    const task = page.locator(".save-task-item")
    await expect(task).toHaveAttribute("data-state", "preparing")
    if (phase === "stop") {
      await page
        .getByRole("button", { name: "停止并保存 摄像头 1", exact: true })
        .click()
      await expect(task).toHaveAttribute("data-state", "stopping")
      await page.keyboard.press("Escape")
      const activity = page.getByRole("region", {
        name: "进行中的录制与下载",
        exact: true,
      })
      await expect(activity.locator(".save-activity-item")).toHaveAttribute(
        "data-state",
        "stopping"
      )
      await expect(activity).toContainText("收尾中")
      await expect(
        activity.getByRole("button", {
          name: "停止并保存 摄像头 1",
          exact: true,
        })
      ).toBeDisabled()
      await page.getByRole("button", { name: "录制与下载任务" }).click()
    }
    await page.clock.fastForward(phase === "startup" ? 20001 : 60001)
    await expect(task).toHaveAttribute("data-state", "failed")
    await expect(task).toContainText(
      phase === "startup" ? "媒体处理启动超时" : "保存收尾超时"
    )
    await expect(
      page.locator('[data-sonner-toast][data-type="error"]')
    ).toContainText(phase === "startup" ? "媒体处理启动超时" : "保存收尾超时")
    expect(mediaRequests).toBe(0)
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { saveWatchdogTerminations: number })
            .saveWatchdogTerminations
      )
    ).toBe(1)
    await page.getByRole("button", { name: "移除任务 摄像头 1" }).click()
    await expect(task).toHaveCount(0)
  })

test("browser recording survives channel/layout/route and preview stop; duplicate windows share one task", async ({
  page,
  context,
}, info) => {
  const source = await syntheticSource(context)
  const deleted = await queries(page)
  await opfsPicker(page)
  await page.goto("/")
  await startRecording(page)
  const first = page.getByRole("region", { name: "窗口 1", exact: true })
  await first.getByRole("button", { name: "开始预览", exact: true }).click()
  await expect(first.locator("video")).toHaveCount(1)
  await page
    .getByRole("button", { name: /全部停止|停止全部预览/, exact: true })
    .click()
  await expect.poll(() => deleted.length).toBe(1)
  await expect.poll(() => source.open.size).toBe(1)
  await selectOption(page, "窗口 1 通道", "摄像头 2")
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await expect(
    first.getByRole("button", { name: "录制 摄像头 2", exact: true })
  ).toBeVisible()
  await selectOption(page, "窗口 2 通道", "摄像头 1")
  await expect(
    page.getByRole("button", { name: "停止录制 摄像头 1", exact: true })
  ).toHaveCount(1)
  expect(
    source.requests
      .filter((request) => request.path === "/live")
      .map((request) => request.body)
  ).toEqual([{ track: "101" }])
  await page.getByRole("button", { name: "1 路", exact: true }).click()
  await expect.poll(() => source.open.size).toBe(1)
  await page.getByRole("link", { name: "录像回放", exact: true }).click()
  await expect(page).toHaveURL(/\/playback$/)
  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toContainText("摄像头 1")
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "saving"
  )
  await page
    .getByRole("button", { name: "停止并保存 摄像头 1", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 15000 }
  )
  await expect.poll(() => source.open.size).toBe(0)
  const files = await savedFiles(page, info)
  expect(files).toHaveLength(1)
  expect(files[0].info.streams.map((stream) => stream.codec_name)).toEqual([
    "h264",
    "pcm_alaw",
  ])
  expect(Number(files[0].info.format.duration)).toBeCloseTo(3, 1)
})

test("HEVC and G711 are streamed into a real browser file and survive tab backgrounding", async ({
  page,
  context,
}, info) => {
  const source = await syntheticSource(context, "hevc")
  await queries(page)
  await opfsPicker(page)
  await page.goto("/")
  await startRecording(page)
  const other = await context.newPage()
  await other.goto("about:blank")
  await other.bringToFront()
  await expect.poll(() => source.open.size).toBe(1)
  await page.bringToFront()
  await page
    .getByRole("button", { name: "停止录制 摄像头 1", exact: true })
    .click()
  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 15000 }
  )
  const files = await savedFiles(page, info)
  expect(files).toHaveLength(1)
  expect(files[0].info.streams.map((stream) => stream.codec_name)).toEqual([
    "hevc",
    "pcm_alaw",
  ])
  expect(Number(files[0].info.format.duration)).toBeCloseTo(3, 3)
  const audioPackets = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_packets",
        "-show_entries",
        "packet=pts_time,duration_time,size",
        "-of",
        "json",
        files[0].path,
      ],
      { encoding: "utf8" }
    )
  ).packets as { pts_time: string; duration_time: string; size: string }[]
  // 1/6s is 1333 1/3 samples at 8kHz. Rounding tfdt to 1333 leaves
  // exactly one source sample before the video origin, which is clipped.
  expect(
    audioPackets.reduce((total, packet) => total + Number(packet.size), 0)
  ).toBe(23999)
  expect(Number(audioPackets[0].pts_time)).toBeCloseTo(0, 3)
  let audioEnd = 0
  for (const packet of audioPackets) {
    const start = Number(packet.pts_time)
    expect(Math.abs(start - audioEnd)).toBeLessThanOrEqual(0.002)
    audioEnd = start + Number(packet.duration_time)
  }
  expect(audioEnd).toBeCloseTo(3, 3)
  await other.close()
})

test("cancelling a browser reload keeps the recording, and a completed recording no longer prompts", async ({
  page,
  context,
}) => {
  const source = await syntheticSource(context)
  await queries(page)
  await opfsPicker(page)
  await page.goto("/")
  await startRecording(page)

  const documentStartedAt = await page.evaluate(() => performance.timeOrigin)
  const confirmation = page.waitForEvent("dialog")
  // A cancelled navigation never reaches DOMContentLoaded; bound the command's
  // wait instead of waiting for the whole test timeout after dismissing it.
  const reload = page.reload({ timeout: 1500 }).catch(() => null)
  const dialog = await confirmation
  expect(dialog.type()).toBe("beforeunload")
  await dialog.dismiss()
  await reload
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    documentStartedAt
  )
  expect(source.open.size).toBe(1)

  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "saving"
  )
  expect(
    source.requests.filter((request) => request.path === "/live")
  ).toHaveLength(1)
  expect(source.open.size).toBe(1)
  await page
    .getByRole("button", { name: "停止并保存 摄像头 1", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 15000 }
  )
  await expect.poll(() => source.open.size).toBe(0)

  const unexpectedDialogs: string[] = []
  page.on("dialog", (unexpected) => {
    unexpectedDialogs.push(unexpected.type())
    void unexpected.dismiss()
  })
  await page.reload()
  await expect(page.getByRole("heading", { name: "实时预览" })).toBeAttached()
  expect(unexpectedDialogs).toEqual([])
})

test("cancelling the location picker starts neither a source nor a recording task", async ({
  page,
  context,
}) => {
  const source = await syntheticSource(context)
  await queries(page)
  await opfsPicker(page, true)
  await page.goto("/")
  await page.getByRole("button", { name: "录制 摄像头 1", exact: true }).click()
  await page
    .getByRole("button", { name: "选择位置并录制", exact: true })
    .click()
  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  await expect(
    page.getByText("暂无录制或下载任务", { exact: true })
  ).toBeVisible()
  await expect(page.locator(".save-task-item")).toHaveCount(0)
  expect(source.requests).toEqual([])
})

test("a browser disk failure is reported and releases its media connection", async ({
  page,
  context,
}) => {
  const source = await syntheticSource(context)
  await queries(page)
  await opfsPicker(page)
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      private waiting: [
        Parameters<Worker["postMessage"]>[0],
        Transferable[] | StructuredSerializeOptions | undefined,
      ][] = []
      private ready = false
      constructor(url: string | URL, options?: WorkerOptions) {
        const script = `const nativeFetch = self.fetch.bind(self); self.fetch = (input, init) => nativeFetch(typeof input === "string" ? new URL(input, ${JSON.stringify(new URL(String(url)).origin)}).href : input, init); FileSystemFileHandle.prototype.createWritable = async function() { throw new DOMException("测试磁盘空间不足", "QuotaExceededError") }; importScripts(${JSON.stringify(String(url))}); self.postMessage({ __diskTestReady: true });`
        super(
          URL.createObjectURL(new Blob([script], { type: "text/javascript" })),
          { ...options, type: undefined }
        )
        this.addEventListener("message", (event) => {
          if (!event.data?.__diskTestReady) return
          this.ready = true
          for (const [value, transfer] of this.waiting)
            NativeWorker.prototype.postMessage.call(
              this,
              value,
              Array.isArray(transfer) ? { transfer } : transfer
            )
          this.waiting = []
        })
      }
      postMessage(
        value: unknown,
        transfer?: Transferable[] | StructuredSerializeOptions
      ) {
        if (!this.ready) this.waiting.push([value, transfer])
        else
          NativeWorker.prototype.postMessage.call(
            this,
            value,
            Array.isArray(transfer) ? { transfer } : transfer
          )
      }
    }
  })
  await page.goto("/")
  await page.getByRole("button", { name: "录制 摄像头 1", exact: true }).click()
  await page
    .getByRole("button", { name: "选择位置并录制", exact: true })
    .click()
  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "failed",
    { timeout: 15000 }
  )
  await expect(page.locator(".save-task-item")).toContainText("磁盘空间不足")
  await expect.poll(() => source.open.size).toBe(0)
})

test("history A/B validation and short original-speed export ignore playback speed and mute", async ({
  page,
  context,
}, info) => {
  const source = await syntheticSource(context)
  await queries(page)
  await opfsPicker(page)
  await page.goto("/playback")
  await page.locator(".timeline-segment").first().click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "播放倍速", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "播放倍速", exact: true }).click()
  await page.getByRole("button", { name: "4×", exact: true }).click()
  await page.getByRole("button", { name: "下载片段", exact: true }).click()
  await page
    .getByRole("textbox", { name: "片段起点", exact: true })
    .fill("00:00:02")
  await page
    .getByRole("textbox", { name: "片段终点", exact: true })
    .fill("00:00:01")
  await page.getByRole("button", { name: "保存选区", exact: true }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "终点必须晚于起点" })
  ).toBeVisible()
  expect(source.requests).toHaveLength(0)
  await page
    .getByRole("textbox", { name: "片段起点", exact: true })
    .fill("00:00:01")
  await page
    .getByRole("textbox", { name: "片段终点", exact: true })
    .fill("00:00:02")
  await page.getByRole("button", { name: "保存选区", exact: true }).click()
  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 15000 }
  )
  await expect(page.locator(".save-task-item")).toContainText(
    "00:00:01 — 00:00:02，原速"
  )
  expect(source.requests.map((request) => request.body)).toEqual([
    { track: "101", date: "2026-10-17", segmentId },
  ])
  const files = await savedFiles(page, info)
  expect(files).toHaveLength(1)
  expect(files[0].info.streams.map((stream) => stream.codec_name)).toEqual([
    "h264",
    "pcm_alaw",
  ])
  expect(Number(files[0].info.format.duration)).toBeGreaterThanOrEqual(0.9)
  expect(Number(files[0].info.format.duration)).toBeLessThanOrEqual(3.1)
})

test("fractional file end can be marked, extended and submitted without truncating its tail", async ({
  page,
  context,
}) => {
  await syntheticSource(context)
  // The media fixture is longer than this authoritative UI duration so the
  // test can position within the fractional final second without an ended event.
  await queries(page, 2.2)
  await opfsPicker(page)
  await page.addInitScript(() => {
    const starts: { start: number; end: number }[] = []
    Object.defineProperty(window, "clipRegressionStarts", { value: starts })
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions
    ) {
      const request = message as {
        type?: string
        source?: { mode?: string; startSeconds: number; endSeconds: number }
      }
      if (request.type === "start" && request.source?.mode === "history")
        starts.push({
          start: request.source.startSeconds,
          end: request.source.endSeconds,
        })
      post.call(
        this,
        message,
        Array.isArray(transfer) ? { transfer } : transfer
      )
    }
  })
  await page.goto("/playback")
  await page.locator(".timeline-segment").first().click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.readyState)
    )
    .toBeGreaterThanOrEqual(1)
  await page.locator("video").evaluate((video: HTMLVideoElement) => {
    video.pause()
    video.currentTime = 2.1
    video.dispatchEvent(new Event("timeupdate"))
  })
  await page.getByRole("button", { name: "下载片段", exact: true }).click()
  const end = page.getByRole("textbox", { name: "片段终点", exact: true })
  await page
    .getByRole("button", { name: "将当前位置设为终点", exact: true })
    .click()
  await expect(end).toHaveValue("00:00:03")
  await end.fill("00:00:01")
  await page.getByRole("button", { name: "后扩 30 秒", exact: true }).click()
  await expect(end).toHaveValue("00:00:03")
  await end.fill("00:00:04")
  await page.getByRole("button", { name: "保存选区", exact: true }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "终点超出完整文件时长" })
  ).toBeVisible()
  await end.fill("00:00:03")
  await page.getByRole("button", { name: "保存选区", exact: true }).click()
  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  await expect(page.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 15000 }
  )
  const starts = await page.evaluate(
    () =>
      (
        window as unknown as {
          clipRegressionStarts: { start: number; end: number }[]
        }
      ).clipRegressionStarts
  )
  expect(starts).toEqual([{ start: 0, end: 2.2 }])
})

test("recording activity stays visible after dialogs close and across routes until the task finishes", async ({
  page,
  context,
}) => {
  const source = await syntheticSource(context)
  await queries(page)
  await opfsPicker(page)
  await page.goto("/")

  const trigger = page
    .getByRole("button", { name: "录制 摄像头 1", exact: true })
    .first()
  await trigger.click()
  const setup = page.getByRole("dialog", { name: "录制 摄像头 1", exact: true })
  await expect(setup).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(setup).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(source.requests).toHaveLength(0)

  await trigger.click()
  await setup
    .getByRole("button", { name: "选择位置并录制", exact: true })
    .click()
  await expect(setup).toBeHidden()
  const activity = page.getByRole("region", {
    name: "进行中的录制与下载",
    exact: true,
  })
  const row = activity.locator(".save-activity-item")
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute("data-state", "saving", { timeout: 20000 })
  await expect(row).toContainText("摄像头 1")
  await expect(row).toContainText("录制中")
  await expect(row).toContainText(/\d{2}:\d{2}:\d{2}/)
  await expect(row).toContainText(/MiB|GiB/)

  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  const details = page.getByRole("dialog", { name: "录制与下载", exact: true })
  await expect(details).toBeVisible()
  await expect(details.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "saving"
  )
  await page.keyboard.press("Escape")
  await expect(details).toBeHidden()
  await expect(activity).toBeVisible()
  expect(source.open.size).toBe(1)

  await page.getByRole("link", { name: "录像回放", exact: true }).click()
  await expect(page).toHaveURL(/\/playback$/)
  await expect(row).toHaveAttribute("data-state", "saving")
  await expect(row).toContainText("摄像头 1")
  expect(
    source.requests.filter((request) => request.path === "/live")
  ).toHaveLength(1)
  await row
    .getByRole("button", { name: "停止并保存 摄像头 1", exact: true })
    .click()
  await expect(activity).toBeHidden({ timeout: 15000 })
  await expect.poll(() => source.open.size).toBe(0)
  const successToast = page.locator('[data-sonner-toast][data-type="success"]')
  await expect(successToast).toBeVisible()
  await expect(successToast).toContainText("摄像头 1 · 已保存")
  await expect(page.locator(".save-result-bar")).toHaveCount(0)
  await successToast
    .getByRole("button", { name: "查看任务", exact: true })
    .click()
  await expect(details).toBeVisible()
  await expect(details.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "complete"
  )
})

test("download activity remains visible while its dialog is closed and navigation continues", async ({
  page,
  context,
}) => {
  let finishHistory!: () => void
  const historyHold = new Promise<void>((resolve) => {
    finishHistory = resolve
  })
  const source = await syntheticSource(context, "h264", historyHold)
  await queries(page)
  await opfsPicker(page)
  try {
    await page.goto("/playback")
    await page.locator(".timeline-segment").first().click()
    await page.getByRole("button", { name: "播放", exact: true }).click()
    const trigger = page.getByRole("button", { name: "下载片段", exact: true })
    await trigger.click()
    const setup = page.getByRole("dialog", {
      name: "下载录像片段",
      exact: true,
    })
    await expect(setup).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(setup).toBeHidden()
    await expect(trigger).toBeFocused()
    expect(source.requests).toHaveLength(0)

    await trigger.click()
    await setup
      .getByRole("textbox", { name: "片段起点", exact: true })
      .fill("00:00:00")
    await setup
      .getByRole("textbox", { name: "片段终点", exact: true })
      .fill("00:00:03")
    await setup.getByRole("button", { name: "保存选区", exact: true }).click()
    await expect(setup).toBeHidden()
    const activity = page.getByRole("region", {
      name: "进行中的录制与下载",
      exact: true,
    })
    const row = activity.locator(".save-activity-item")
    await expect(row).toHaveAttribute("data-state", "saving", {
      timeout: 20000,
    })
    await expect(row).toContainText("下载中")
    await expect(row).toContainText("摄像头 1")
    await expect(row).toContainText(/MiB|GiB/)
    await page
      .getByRole("button", { name: "录制与下载任务", exact: true })
      .click()
    const details = page.getByRole("dialog", {
      name: "录制与下载",
      exact: true,
    })
    await expect(details).toBeVisible()
    await expect(details.locator(".save-task-item")).toHaveAttribute(
      "data-state",
      "saving"
    )
    await page.keyboard.press("Escape")
    await expect(details).toBeHidden()
    await expect(activity).toBeVisible()

    await page.getByRole("link", { name: "实时预览", exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(row).toContainText("下载中")
    expect(
      source.requests.filter((request) => request.path === "/history")
    ).toHaveLength(1)
    finishHistory()
    await expect(activity).toBeHidden({ timeout: 15000 })
    await page
      .getByRole("button", { name: "录制与下载任务", exact: true })
      .click()
    await expect(details.locator(".save-task-item")).toHaveAttribute(
      "data-state",
      "complete"
    )
  } finally {
    finishHistory()
  }
})

test("save triggers align with existing controls and dialogs fit a 390px viewport", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const source = await syntheticSource(context)
  await queries(page)
  await opfsPicker(page)
  await page.goto("/")

  const tasksTrigger = page.locator(".save-tasks-trigger")
  const taskPanel = page.getByRole("dialog", {
    name: "录制与下载",
    exact: true,
  })
  async function expectNavColors(open: boolean) {
    await expect(tasksTrigger).toHaveAttribute("aria-expanded", String(open))
    await expect
      .poll(() =>
        page.locator(".console-nav").evaluate((nav, open) => {
          const taskStyle = getComputedStyle(
            nav.querySelector(".save-tasks-trigger")!
          )
          const linkStyle = getComputedStyle(
            nav.querySelector(
              open ? 'a[aria-current="page"]' : "a:not([aria-current])"
            )!
          )
          return {
            text: taskStyle.color === linkStyle.color,
            background: taskStyle.backgroundColor === linkStyle.backgroundColor,
          }
        }, open)
      )
      .toEqual({ text: true, background: true })
  }
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator("html")).toHaveClass(new RegExp(colorScheme))
    await page.mouse.move(0, 0)
    await expectNavColors(false)
    await tasksTrigger.click()
    await expect(taskPanel).toBeVisible()
    await expectNavColors(true)
    await page.keyboard.press("Escape")
    await expect(taskPanel).toBeHidden()
    await page.mouse.move(0, 0)
    await expectNavColors(false)
  }
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveClass(/light/)

  const navButton = await page.locator(".save-tasks-trigger").boundingBox()
  const navLink = await page
    .getByRole("link", { name: "实时预览", exact: true })
    .boundingBox()
  expect(navButton).not.toBeNull()
  expect(navLink).not.toBeNull()
  expect(Math.abs(navButton!.height - navLink!.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(navButton!.y - navLink!.y)).toBeLessThanOrEqual(1)
  const first = page.getByRole("region", { name: "窗口 1", exact: true })
  const recordBox = await first.locator(".live-record-trigger").boundingBox()
  const channelBox = await page
    .getByRole("combobox", { name: "窗口 1 通道", exact: true })
    .boundingBox()
  expect(recordBox).not.toBeNull()
  expect(channelBox).not.toBeNull()
  expect(recordBox!.height).toBe(28)
  expect(
    Math.abs(
      recordBox!.y +
        recordBox!.height / 2 -
        channelBox!.y -
        channelBox!.height / 2
    )
  ).toBeLessThanOrEqual(1)

  await first
    .getByRole("button", { name: "录制 摄像头 1", exact: true })
    .click()
  const setup = page.getByRole("dialog", { name: "录制 摄像头 1", exact: true })
  await expect(setup).toBeVisible()
  const setupBox = await setup.boundingBox()
  expect(setupBox!.x).toBeGreaterThanOrEqual(0)
  expect(setupBox!.x + setupBox!.width).toBeLessThanOrEqual(390)
  await setup
    .getByRole("button", { name: "选择位置并录制", exact: true })
    .click()
  const activity = page.getByRole("region", {
    name: "进行中的录制与下载",
    exact: true,
  })
  await expect(activity.locator(".save-activity-item")).toHaveAttribute(
    "data-state",
    "saving",
    { timeout: 20000 }
  )
  const activityBox = await activity.boundingBox()
  expect(activityBox!.x).toBeGreaterThanOrEqual(0)
  expect(activityBox!.x + activityBox!.width).toBeLessThanOrEqual(390)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(390)
  await activity
    .getByRole("button", { name: "停止并保存 摄像头 1", exact: true })
    .click()
  await expect(activity).toBeHidden({ timeout: 15000 })
  await expect.poll(() => source.open.size).toBe(0)

  await page.getByRole("link", { name: "录像回放", exact: true }).click()
  await page.locator(".timeline-segment").first().click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  const download = page.getByRole("button", { name: "下载片段", exact: true })
  await expect(download).toHaveClass(/player-control-button/)
  const downloadBox = await download.boundingBox()
  expect(downloadBox!.width).toBe(28)
  expect(downloadBox!.height).toBe(28)
  const fullscreenBox = await page
    .getByRole("button", { name: "全屏", exact: true })
    .boundingBox()
  expect(fullscreenBox!.height).toBe(downloadBox!.height)
  expect(Math.abs(fullscreenBox!.y - downloadBox!.y)).toBeLessThanOrEqual(1)
  await download.click()
  const clipDialog = page.getByRole("dialog", {
    name: "下载录像片段",
    exact: true,
  })
  await expect(clipDialog).toBeVisible()
  const clipBox = await clipDialog.boundingBox()
  expect(clipBox!.x).toBeGreaterThanOrEqual(0)
  expect(clipBox!.x + clipBox!.width).toBeLessThanOrEqual(390)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(390)
})

test("fullscreen keeps the recording indicator visible and contains task and clip dialogs", async ({
  page,
  context,
}) => {
  const source = await syntheticSource(context)
  await queries(page)
  await opfsPicker(page)
  await page.goto("/")
  await startRecording(page)
  const first = page.getByRole("region", { name: "窗口 1", exact: true })
  await first.getByRole("button", { name: "开始预览", exact: true }).click()
  const indicator = first.locator(".live-recording-indicator")
  await expect(indicator).toBeVisible()
  await expect(indicator).toContainText("录制中")
  await expect(indicator).toContainText(/\d{2}:\d{2}:\d{2}/)
  await first.getByRole("button", { name: "全屏", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true)
  await expect(indicator).toBeVisible()
  const fullscreenActivity = first.locator(".save-fullscreen-activity")
  await expect(fullscreenActivity).toBeVisible()
  await expect(fullscreenActivity).toContainText("摄像头 1")
  await expect(fullscreenActivity).toContainText("录制中")
  await fullscreenActivity.click()
  const details = page.getByRole("dialog", { name: "录制与下载", exact: true })
  await expect(details).toBeVisible()
  expect(
    await details.evaluate((element) =>
      document.fullscreenElement?.contains(element)
    )
  ).toBe(true)
  await details
    .getByRole("button", { name: "关闭任务面板", exact: true })
    .click()
  await expect(details).toBeHidden()
  await expect(indicator).toBeVisible()
  expect(source.open.size).toBe(1)
  await fullscreenActivity.click()
  await details
    .getByRole("button", { name: "停止并保存 摄像头 1", exact: true })
    .click()
  await expect(details.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 15000 }
  )
  await details
    .getByRole("button", { name: "关闭任务面板", exact: true })
    .click()
  await expect(indicator).toBeHidden()
  await expect(fullscreenActivity).toBeVisible()
  await expect(fullscreenActivity).toContainText("保存已结束")
  await expect(fullscreenActivity).toContainText("查看结果")
  const successToast = page.locator('[data-sonner-toast][data-type="success"]')
  await expect(successToast).toBeVisible()
  await successToast.hover()
  expect(
    await successToast.evaluate((element) =>
      document.fullscreenElement?.contains(element)
    )
  ).toBe(true)
  await expect(page.locator("[data-sonner-toaster]")).toHaveCount(1)
  await page.evaluate(() => document.exitFullscreen())
  await expect(successToast).toBeVisible()
  await successToast.hover()
  await expect(page.locator("[data-sonner-toaster]")).toHaveCount(1)
  await successToast
    .getByRole("button", { name: "查看任务", exact: true })
    .click()
  await expect(details).toBeVisible()
  await expect(details.locator(".save-task-item")).toHaveAttribute(
    "data-state",
    "complete"
  )
  await details
    .getByRole("button", { name: "关闭任务面板", exact: true })
    .click()
  const activity = page.getByRole("region", {
    name: "进行中的录制与下载",
    exact: true,
  })
  await expect(activity).toBeHidden({ timeout: 15000 })
  await expect.poll(() => source.open.size).toBe(0)

  await page.getByRole("link", { name: "录像回放", exact: true }).click()
  await page.locator(".timeline-segment").first().click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await page.getByRole("button", { name: "全屏", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true)
  await page.getByRole("button", { name: "下载片段", exact: true }).click()
  const clip = page.getByRole("dialog", { name: "下载录像片段", exact: true })
  await expect(clip).toBeVisible()
  expect(
    await clip.evaluate((element) =>
      document.fullscreenElement?.contains(element)
    )
  ).toBe(true)
  await page.keyboard.press("Escape")
  await expect(clip).toBeHidden()
  await page.evaluate(() => document.exitFullscreen())
})

test("four concurrent saves reject a fifth task and stop independently before cleanup", async ({
  page,
  context,
}, info) => {
  const source = await syntheticSource(context)
  await queries(page)
  await opfsPicker(page)
  await page.goto("/")
  const activity = page.getByRole("region", {
    name: "进行中的录制与下载",
    exact: true,
  })
  const rowFor = (camera: number) =>
    activity.locator(".save-activity-item").filter({
      has: page.getByText(`摄像头 ${camera}`, { exact: true }),
    })

  for (const camera of [1, 2, 3, 4]) {
    await page
      .getByRole("button", { name: `录制 摄像头 ${camera}`, exact: true })
      .click()
    await page
      .getByRole("dialog", { name: `录制 摄像头 ${camera}`, exact: true })
      .getByRole("button", { name: "选择位置并录制", exact: true })
      .click()
    await expect(rowFor(camera)).toHaveAttribute("data-state", "saving", {
      timeout: 20000,
    })
  }
  await expect(activity.locator(".save-activity-item")).toHaveCount(4)
  await expect.poll(() => source.open.size).toBe(4)
  expect(source.requests.map((request) => request.body)).toEqual([
    { track: "101" },
    { track: "201" },
    { track: "301" },
    { track: "401" },
  ])

  // A history export uses the same activity limit as the live recordings.
  await page.getByRole("link", { name: "录像回放", exact: true }).click()
  await page.locator(".timeline-segment").first().click()
  await page.getByRole("button", { name: "播放", exact: true }).click()
  await page.getByRole("button", { name: "下载片段", exact: true }).click()
  const clip = page.getByRole("dialog", {
    name: "下载录像片段",
    exact: true,
  })
  await clip
    .getByRole("textbox", { name: "片段终点", exact: true })
    .fill("00:00:03")
  await clip.getByRole("button", { name: "保存选区", exact: true }).click()
  await expect(
    page.locator('[data-sonner-toast][data-type="warning"]')
  ).toContainText("最多同时保存 4 个任务，请先停止其他任务。")
  await expect(activity.locator(".save-activity-item")).toHaveCount(4)
  expect(source.requests).toHaveLength(4)
  expect(source.open.size).toBe(4)

  await rowFor(2)
    .getByRole("button", { name: "停止并保存 摄像头 2", exact: true })
    .click()
  await expect(rowFor(2)).toHaveCount(0, { timeout: 15000 })
  await expect.poll(() => source.open.size).toBe(3)
  for (const camera of [1, 3, 4])
    await expect(rowFor(camera)).toHaveAttribute("data-state", "saving")
  expect(source.requests).toHaveLength(4)

  for (const camera of [1, 3, 4])
    await rowFor(camera)
      .getByRole("button", {
        name: `停止并保存 摄像头 ${camera}`,
        exact: true,
      })
      .click()
  await expect(activity).toBeHidden({ timeout: 15000 })
  await expect.poll(() => source.open.size).toBe(0)
  await page
    .getByRole("button", { name: "录制与下载任务", exact: true })
    .click()
  const tasks = page
    .getByRole("dialog", { name: "录制与下载", exact: true })
    .locator(".save-task-item")
  await expect(tasks).toHaveCount(4)
  for (const task of await tasks.all())
    await expect(task).toHaveAttribute("data-state", "complete")
  const files = await savedFiles(page, info)
  expect(files).toHaveLength(4)
  for (const file of files) {
    expect(file.info.streams.map((stream) => stream.codec_name)).toEqual([
      "h264",
      "pcm_alaw",
    ])
    expect(Number(file.info.format.duration)).toBeCloseTo(3, 1)
  }
})
