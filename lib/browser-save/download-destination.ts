import type { SaveDestination } from "./types"
import {
  SAVE_PROTOCOL,
  cancelled,
  waitForRegistration,
  waitForActivation,
  waitForPort,
  type DownloadSession,
} from "./download-bridge"

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

export async function downloadDestination(
  id: string,
  filename: string
): Promise<SaveDestination> {
  const session: DownloadSession = { controller: new AbortController() }
  downloads.set(id, session)
  try {
    const registration = await waitForRegistration(
      navigator.serviceWorker.register(
        `/browser-save-sw.js?v=${SAVE_PROTOCOL}`,
        {
          scope: "/local-saves/",
          updateViaCache: "none",
        }
      ),
      session.controller.signal
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
    await waitForPort(
      session,
      "registered",
      10000,
      "浏览器未响应保存请求。",
      () => {
        try {
          worker.postMessage({ type: "register-save", id, filename }, [
            channel.port2,
          ])
        } catch (error) {
          channel.port2.close()
          throw error
        }
        // Ownership now belongs to the SW. Closing this transferred handle
        // after its acknowledgment also closes the receiver in native Safari.
      }
    )
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
