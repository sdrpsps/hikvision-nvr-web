// Same-origin streaming downloads. No video, credentials, URLs or chunks are
// persisted in the service worker, CacheStorage or IndexedDB.
const SAVE_PROTOCOL = 2
const pending = new Map()
const active = new Map()
const validId = (id) => /^[a-f0-9-]{36}$/.test(id)
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
)
self.addEventListener("message", (event) => {
  const id = event.data?.id
  if (!validId(id)) return
  if (event.data?.type === "release-save") {
    const save = pending.get(id) ?? active.get(id)
    if (save?.owner && save.owner !== event.source?.id) return
    if (pending.has(id)) {
      pending.delete(id)
      clearTimeout(save.timer)
      save.port.postMessage({ type: "cancel" })
      save.port.close()
    }
    active.get(id)?.cancel()
    event.ports[0]?.postMessage({ type: "released" })
    event.ports[0]?.close()
    return
  }
  if (event.data?.type !== "register-save" || !event.ports[0]) return
  const { filename } = event.data
  const port = event.ports[0]
  if (pending.size + active.size >= 8 || pending.has(id) || active.has(id)) {
    port.postMessage({ type: "cancel" })
    port.close()
    return
  }
  const timer = setTimeout(() => {
    pending.delete(id)
    port.postMessage({ type: "cancel" })
    port.close()
  }, 60000)
  pending.set(id, {
    port,
    owner: event.source?.id,
    filename: String(filename).replace(/[\r\n]/g, ""),
    timer,
  })
  port.postMessage({ type: "registered", protocol: SAVE_PROTOCOL })
})
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith("/local-saves/")
  )
    return
  const id = url.pathname.split("/")[2]
  const save = pending.get(id)
  if (!save) {
    event.respondWith(
      new Response("保存任务已过期，请重新开始。", { status: 404 })
    )
    return
  }
  pending.delete(id)
  clearTimeout(save.timer)
  let pull
  let started = false
  let settled = false
  let writerReady = false
  let demandPending = false
  let creditGranted = false
  let idleTimer
  const clearIdle = () => clearTimeout(idleTimer)
  const releasePull = () => {
    pull?.()
    pull = undefined
  }
  const requestChunk = () => {
    if (!settled && writerReady && demandPending && !creditGranted) {
      creditGranted = true
      save.port.postMessage({ type: "pull" })
    }
  }
  let streamController
  const finish = (kind) => {
    if (settled) return
    settled = true
    clearIdle()
    active.delete(id)
    save.port.onmessage = null
    save.port.onmessageerror = null
    if (kind === "close") {
      streamController.close()
      save.port.postMessage({ type: "closed" })
    } else {
      if (kind !== "consumer-cancel")
        streamController.error(new Error("媒体保存中断"))
      save.port.postMessage({ type: "cancel" })
    }
    save.port.close()
    releasePull()
  }
  const stream = new ReadableStream(
    {
      start(controller) {
        streamController = controller
        active.set(id, {
          owner: save.owner,
          cancel: () => finish("release"),
        })
        const watchIdle = () => {
          clearIdle()
          idleTimer = setTimeout(() => finish("timeout"), 90000)
        }
        watchIdle()
        save.port.onmessage = (message) => {
          if (settled) return
          const data = message.data
          if (data.type === "writer-ready") {
            writerReady = true
            requestChunk()
          } else if (data.type === "chunk") {
            if (!creditGranted) {
              finish("error")
              return
            }
            creditGranted = false
            demandPending = false
            watchIdle()
            controller.enqueue(new Uint8Array(data.bytes))
            save.port.postMessage({ type: "ack", sequence: data.sequence })
            releasePull()
          } else if (data.type === "close") {
            finish("close")
          } else if (data.type === "error") {
            finish("error")
          }
        }
        save.port.onmessageerror = () => finish("error")
        save.port.start()
      },
      pull() {
        if (!started) {
          started = true
          save.port.postMessage({ type: "started" })
        }
        return new Promise((resolve) => {
          pull = resolve
          // The page consumes `started` before transferring its already-started
          // port to the media Worker. Wait for that writer's explicit readiness
          // so the first credit cannot be dispatched into the handoff gap.
          demandPending = true
          requestChunk()
        })
      },
      cancel() {
        finish("consumer-cancel")
      },
    },
    { highWaterMark: 0 }
  )
  event.respondWith(
    new Response(stream, {
      headers: {
        "Content-Type": "video/x-matroska",
        "Content-Disposition":
          "attachment; filename*=UTF-8''" + encodeURIComponent(save.filename),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    })
  )
})
