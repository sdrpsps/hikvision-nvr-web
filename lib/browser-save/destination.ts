import type { LocalDirectory, LocalFile, SaveDestination } from "./types"

const SAVE_PROTOCOL = 2

type PickerWindow = Window & {
  showSaveFilePicker?: (options: unknown) => Promise<LocalFile>
  showDirectoryPicker?: (options: unknown) => Promise<LocalDirectory>
}
type DownloadSession = {
  controller: AbortController
  worker?: ServiceWorker
  port?: MessagePort
  frame?: HTMLIFrameElement
}
const downloads = new Map<string, DownloadSession>()

export function releaseDestination(id: string) {
  const session = downloads.get(id)
  if (!session) return
  downloads.delete(id)
  session.controller.abort()
  try {
    // The port may already belong to the media worker, so use the SW's
    // independent control channel to release both pending and active streams.
    session.worker?.postMessage({ type: "release-save", id })
  } catch {
    /* A terminated service worker has no live stream left to release. */
  }
  session.port?.close()
  session.frame?.remove()
}

function cancelled() {
  return new DOMException("保存已取消。", "AbortError")
}

function waitForActivation(worker: ServiceWorker, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", aborted)
      worker.removeEventListener("statechange", changed)
      if (error) reject(error)
      else resolve()
    }
    const aborted = () => finish(cancelled())
    const changed = () => {
      if (signal.aborted) aborted()
      else if (worker.state === "activated") finish()
      else if (worker.state === "redundant")
        finish(new Error("流式保存未能启动，请重试。"))
    }
    const timeout = setTimeout(
      () => finish(new Error("流式保存初始化超时，请重试。")),
      15000
    )
    signal.addEventListener("abort", aborted, { once: true })
    worker.addEventListener("statechange", changed)
    changed()
  })
}

function waitForPort(
  session: DownloadSession,
  type: "registered" | "started",
  timeoutMs: number,
  timeoutMessage: string,
  start: () => void
) {
  const port = session.port!
  const signal = session.controller.signal
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", aborted)
      port.removeEventListener("message", message)
      port.removeEventListener("messageerror", invalid)
      if (error) reject(error)
      else resolve()
    }
    const aborted = () => finish(cancelled())
    const invalid = () => finish(new Error("浏览器无法建立流式保存连接。"))
    const message = (event: MessageEvent) => {
      if (event.data?.type === type) {
        if (type === "registered" && event.data.protocol !== SAVE_PROTOCOL)
          finish(new Error("流式保存组件版本不一致，请刷新页面后重试。"))
        else finish()
      } else if (event.data?.type === "cancel") aborted()
    }
    const timeout = setTimeout(
      () => finish(new Error(timeoutMessage)),
      timeoutMs
    )
    signal.addEventListener("abort", aborted, { once: true })
    port.addEventListener("message", message)
    port.addEventListener("messageerror", invalid)
    port.start()
    if (signal.aborted) {
      aborted()
      return
    }
    try {
      start()
    } catch (error) {
      finish(error instanceof Error ? error : new Error("无法准备流式保存。"))
    }
  })
}

export function saveCapability() {
  if (typeof window === "undefined") return "pending"
  if (!window.isSecureContext) return "insecure"
  if ((window as PickerWindow).showSaveFilePicker) return "direct"
  return "serviceWorker" in navigator ? "download" : "unsupported"
}

async function downloadDestination(
  id: string,
  filename: string
): Promise<SaveDestination> {
  const session: DownloadSession = { controller: new AbortController() }
  downloads.set(id, session)
  try {
    const registration = await navigator.serviceWorker.register(
      `/browser-save-sw.js?v=${SAVE_PROTOCOL}`,
      { scope: "/local-saves/", updateViaCache: "none" }
    )
    if (session.controller.signal.aborted) throw cancelled()
    // register() can return an old active worker while an updated protocol is
    // installing. Wait for the new worker instead of sending it old messages.
    const worker =
      registration.installing ?? registration.waiting ?? registration.active
    if (!worker)
      throw new Error("浏览器无法准备流式保存，请使用最新版 Chrome 或 Edge。")
    session.worker = worker
    await waitForActivation(worker, session.controller.signal)
    const channel = new MessageChannel()
    session.port = channel.port1
    try {
      await waitForPort(
        session,
        "registered",
        10000,
        "浏览器未响应保存请求。",
        () =>
          worker.postMessage({ type: "register-save", id, filename }, [
            channel.port2,
          ])
      )
    } finally {
      // close() is harmless after transfer, and also handles a clone failure.
      channel.port2.close()
    }
    // Navigate in a hidden frame: <a download> bypasses this SW in Chromium,
    // while a new window may be blocked after asynchronous initialization.
    const frame = document.createElement("iframe")
    session.frame = frame
    frame.hidden = true
    frame.setAttribute("aria-hidden", "true")
    frame.title = "流式保存文件"
    await waitForPort(
      session,
      "started",
      30000,
      "浏览器未启动流式下载，请检查下载列表；仍失败时请使用最新版 Chrome 或 Edge。",
      () => {
        frame.src = `/local-saves/${id}/${encodeURIComponent(filename)}`
        document.body.append(frame)
      }
    )
    return { type: "download", port: channel.port1 }
  } catch (error) {
    releaseDestination(id)
    throw error
  }
}

export async function chooseDestination(
  id: string,
  filename: string,
  segmented: boolean
): Promise<SaveDestination> {
  const capability = saveCapability()
  if (capability === "insecure")
    throw new Error("直接写盘需要 HTTPS；本机调试请使用 localhost 地址。")
  if (capability === "unsupported")
    throw new Error("当前浏览器不支持流式保存，请使用最新版 Chrome 或 Edge。")
  const picker = window as PickerWindow
  if (segmented && picker.showDirectoryPicker)
    return {
      type: "directory",
      directory: await picker.showDirectoryPicker({
        mode: "readwrite",
        id: "nvr-recordings",
      }),
    }
  if (picker.showSaveFilePicker)
    return {
      type: "file",
      file: await picker.showSaveFilePicker({
        suggestedName: filename,
        id: "nvr-clips",
        types: [
          {
            description: "保留原始音视频的 MKV 录像",
            accept: { "video/x-matroska": [".mkv"] },
          },
        ],
      }),
    }
  return downloadDestination(id, filename)
}
