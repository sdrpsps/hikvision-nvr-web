import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, expect, type Page } from "@playwright/test"

test.use({ launchOptions: { ignoreDefaultArgs: ["--disable-popup-blocking"] } })

type SaveHarness = {
  id: string
  worker: ServiceWorker
  port: MessagePort
  allowance: number
  acknowledgments: number
  writes: number
  pulls: number
  maxOutstanding: number
  outstanding: number
  started: boolean
  closed: boolean
  cancelled: boolean
  error?: string
  finished: boolean
  reader?: ReadableStreamDefaultReader<Uint8Array>
  send(chunks: number, chunkBytes: number, pauseMs?: number): Promise<void>
}
declare global {
  interface Window {
    streamSaveHarness: SaveHarness
  }
}

async function registerSave(page: Page, filename: string, id?: string) {
  return page.evaluate(
    async ({ filename, id }) => {
      const registration = await navigator.serviceWorker.register(
        "/browser-save-sw.js?v=2",
        { scope: "/local-saves/", updateViaCache: "none" }
      )
      const worker =
        registration.installing ?? registration.waiting ?? registration.active
      if (!worker) throw new Error("No streaming save worker")
      if (worker.state !== "activated") {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Activation timeout")),
            10_000
          )
          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") {
              clearTimeout(timeout)
              resolve()
            }
          })
        })
      }
      const channel = new MessageChannel()
      const harness: SaveHarness = {
        id: id ?? crypto.randomUUID(),
        worker,
        port: channel.port1,
        allowance: 0,
        acknowledgments: 0,
        writes: 0,
        pulls: 0,
        maxOutstanding: 0,
        outstanding: 0,
        started: false,
        closed: false,
        cancelled: false,
        finished: false,
        async send(chunks, chunkBytes, pauseMs = 0) {
          channel.port1.postMessage({ type: "writer-ready" })
          async function waitFor(check: () => boolean) {
            const deadline = Date.now() + 20_000
            while (!check()) {
              if (harness.cancelled) throw new Error("Download cancelled")
              if (Date.now() > deadline) throw new Error("Writer timeout")
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
          }
          try {
            for (let index = 0; index < chunks; index++) {
              await waitFor(() => harness.allowance > 0)
              harness.allowance--
              const bytes = new Uint8Array(chunkBytes)
              for (let i = 0; i < bytes.length; i++)
                bytes[i] =
                  ((index * chunkBytes + i) * 31 +
                    ((index * chunkBytes + i) >>> 8)) &
                  255
              harness.outstanding++
              harness.maxOutstanding = Math.max(
                harness.maxOutstanding,
                harness.outstanding
              )
              channel.port1.postMessage(
                { type: "chunk", sequence: index + 1, bytes: bytes.buffer },
                [bytes.buffer]
              )
              harness.writes++
              await waitFor(() => harness.acknowledgments >= index + 1)
              if (pauseMs)
                await new Promise((resolve) => setTimeout(resolve, pauseMs))
            }
            channel.port1.postMessage({ type: "close" })
            await waitFor(() => harness.closed)
          } catch (error) {
            harness.error =
              error instanceof Error ? error.message : String(error)
          } finally {
            harness.finished = true
          }
        },
      }
      window.streamSaveHarness = harness
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Registration timeout")),
          10_000
        )
        channel.port1.onmessage = (event) => {
          if (event.data.type === "registered") {
            clearTimeout(timeout)
            if (event.data.protocol !== 2) {
              reject(new Error("Unexpected streaming save protocol"))
              return
            }
            resolve()
          }
          if (event.data.type === "started") harness.started = true
          if (event.data.type === "pull") {
            harness.allowance++
            harness.pulls++
          }
          if (event.data.type === "ack") {
            harness.acknowledgments++
            harness.outstanding--
          }
          if (event.data.type === "closed") harness.closed = true
          if (event.data.type === "cancel") harness.cancelled = true
        }
        channel.port1.start()
        worker.postMessage(
          { type: "register-save", id: harness.id, filename },
          [channel.port2]
        )
      })
      return harness.id
    },
    { filename, id }
  )
}

async function releaseSave(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const channel = new MessageChannel()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        channel.port1.close()
        reject(new Error("Release control was not acknowledged"))
      }, 3000)
      channel.port1.onmessage = (event) => {
        if (event.data?.type !== "released") return
        clearTimeout(timeout)
        channel.port1.close()
        resolve()
      }
      window.streamSaveHarness.worker.postMessage(
        { type: "release-save", id },
        [channel.port2]
      )
    })
  }, id)
}

async function fixturePage(page: Page) {
  await page.goto("/api/health")
  expect(await page.evaluate(() => isSecureContext)).toBe(true)
}

async function controlledFixturePage(page: Page) {
  await fixturePage(page)
  // A client must be controlled by this scope for ordinary fetch() interception.
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register(
      "/browser-save-sw.js?v=2",
      { scope: "/local-saves/", updateViaCache: "none" }
    )
    const worker =
      registration.installing ?? registration.waiting ?? registration.active
    if (worker?.state !== "activated")
      await new Promise<void>((resolve) =>
        worker?.addEventListener("statechange", () => {
          if (worker.state === "activated") resolve()
        })
      )
  })
  await page.goto("/local-saves/controlled-test-client")
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true)
}

function expectedHash(chunks: number, chunkBytes: number) {
  const hash = createHash("sha256")
  for (let index = 0; index < chunks; index++) {
    const bytes = Buffer.alloc(chunkBytes)
    for (let i = 0; i < bytes.length; i++)
      bytes[i] =
        ((index * chunkBytes + i) * 31 + ((index * chunkBytes + i) >>> 8)) & 255
    hash.update(bytes)
  }
  return hash.digest("hex")
}

test("self-hosted worker streams an exact native download without a complete Blob", async ({
  page,
}) => {
  await fixturePage(page)
  const filename = "合成流式保存测试.bin"
  const id = await registerSave(page, filename)
  const chunks = 256,
    chunkBytes = 64 * 1024
  const downloadPromise = page.waitForEvent("download")
  await page.evaluate(
    ({ id, filename, chunks, chunkBytes }) => {
      const frame = document.createElement("iframe")
      frame.hidden = true
      frame.src = `/local-saves/${id}/${encodeURIComponent(filename)}`
      document.body.append(frame)
      void window.streamSaveHarness.send(chunks, chunkBytes)
    },
    { id, filename, chunks, chunkBytes }
  )
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(filename)
  const root = await mkdtemp(join(tmpdir(), "nvr-stream-save-"))
  try {
    const target = join(root, "synthetic.bin")
    try {
      await download.saveAs(target)
    } catch (error) {
      const stats = await page.evaluate(() => ({
        writes: window.streamSaveHarness.writes,
        pulls: window.streamSaveHarness.pulls,
        closed: window.streamSaveHarness.closed,
        cancelled: window.streamSaveHarness.cancelled,
        finished: window.streamSaveHarness.finished,
        error: window.streamSaveHarness.error,
      }))
      throw new Error(
        `${String(error)}; state=${JSON.stringify(stats)}; url=${download.url()}`
      )
    }
    expect(await download.failure()).toBeNull()
    expect((await stat(target)).size).toBe(chunks * chunkBytes)
    const actual = createHash("sha256")
    for await (const bytes of createReadStream(target)) actual.update(bytes)
    expect(actual.digest("hex")).toBe(expectedHash(chunks, chunkBytes))
    const stats = await page.evaluate(() => ({
      writes: window.streamSaveHarness.writes,
      maxOutstanding: window.streamSaveHarness.maxOutstanding,
      started: window.streamSaveHarness.started,
      closed: window.streamSaveHarness.closed,
      error: window.streamSaveHarness.error,
    }))
    expect(stats).toEqual({
      writes: chunks,
      maxOutstanding: 1,
      started: true,
      closed: true,
      error: undefined,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("worker backpressure stops an unread source and cancellation reaches the producer", async ({
  page,
}) => {
  await controlledFixturePage(page)
  const id = await registerSave(page, "backpressure.bin")
  await page.evaluate(async (id) => {
    const response = await fetch(`/local-saves/${id}/backpressure.bin`)
    window.streamSaveHarness.reader = response.body!.getReader()
    void window.streamSaveHarness.send(4096, 64 * 1024)
  }, id)
  await expect
    .poll(() => page.evaluate(() => window.streamSaveHarness.writes))
    .toBeGreaterThan(0)
  await page.waitForTimeout(350)
  const before = await page.evaluate(() => window.streamSaveHarness.writes)
  await page.waitForTimeout(350)
  const after = await page.evaluate(() => window.streamSaveHarness.writes)
  expect(after).toBeLessThan(4096)
  expect(after - before).toBeLessThanOrEqual(1)
  await page.evaluate(async () => {
    await window.streamSaveHarness.reader!.cancel(
      "Synthetic consumer cancellation"
    )
  })
  await expect
    .poll(() => page.evaluate(() => window.streamSaveHarness.cancelled))
    .toBe(true)
  await expect
    .poll(() => page.evaluate(() => window.streamSaveHarness.finished))
    .toBe(true)
  expect(await page.evaluate(() => window.streamSaveHarness.error)).toBe(
    "Download cancelled"
  )
})

test("release control immediately removes pending saves and frees their slots", async ({
  page,
}) => {
  await fixturePage(page)
  let id: string | undefined
  // Reuse the same opaque id more often than the eight-slot bound. This fails
  // immediately if release merely closes a UI port and leaves SW state behind.
  for (let attempt = 0; attempt < 10; attempt++) {
    id = await registerSave(page, "released-before-start.bin", id)
    await releaseSave(page, id)
    await expect
      .poll(() => page.evaluate(() => window.streamSaveHarness.cancelled), {
        timeout: 3000,
      })
      .toBe(true)
    await page.evaluate(() => window.streamSaveHarness.port.close())
  }
  const response = await page.goto(
    `/local-saves/${id}/released-before-start.bin`
  )
  expect(response?.status()).toBe(404)
})

test("release control interrupts an active stalled stream without waiting for its idle timeout", async ({
  page,
}) => {
  await controlledFixturePage(page)
  const id = await registerSave(page, "released-active.bin")
  await page.evaluate(async (id) => {
    const response = await fetch(`/local-saves/${id}/released-active.bin`)
    window.streamSaveHarness.reader = response.body!.getReader()
    void window.streamSaveHarness.send(4096, 64 * 1024)
  }, id)
  await expect
    .poll(() => page.evaluate(() => window.streamSaveHarness.writes))
    .toBeGreaterThan(0)
  await releaseSave(page, id)
  await expect
    .poll(() => page.evaluate(() => window.streamSaveHarness.cancelled), {
      timeout: 3000,
    })
    .toBe(true)
  await expect
    .poll(() => page.evaluate(() => window.streamSaveHarness.finished), {
      timeout: 3000,
    })
    .toBe(true)
  expect(
    await page.evaluate(async () => {
      try {
        while (!(await window.streamSaveHarness.reader!.read()).done) {
          /* Drain any browser-buffered chunks before observing the failure. */
        }
        return false
      } catch {
        return true
      }
    })
  ).toBe(true)
  expect(
    await page.evaluate(async (id) => {
      const response = await fetch(`/local-saves/${id}/released-active.bin`)
      return response.status
    }, id)
  ).toBe(404)
  expect(await registerSave(page, "new-task-after-release.bin", id)).toBe(id)
  await releaseSave(page, id)
})

test("cancelling a native download releases the worker producer", async ({
  page,
}) => {
  await fixturePage(page)
  const id = await registerSave(page, "cancelled-stream.bin")
  const downloadPromise = page.waitForEvent("download")
  await page.evaluate((id) => {
    const frame = document.createElement("iframe")
    frame.hidden = true
    frame.src = `/local-saves/${id}/cancelled-stream.bin`
    document.body.append(frame)
    void window.streamSaveHarness.send(4096, 64 * 1024, 15)
  }, id)
  const download = await downloadPromise
  await download.cancel()
  expect(await download.failure()).toBe("canceled")
  await expect
    .poll(() => page.evaluate(() => window.streamSaveHarness.cancelled))
    .toBe(true)
  await expect
    .poll(() => page.evaluate(() => window.streamSaveHarness.finished))
    .toBe(true)
})
