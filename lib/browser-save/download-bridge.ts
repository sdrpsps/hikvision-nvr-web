export const SAVE_PROTOCOL = 2
export type DownloadSession = {
  controller: AbortController
  worker?: ServiceWorker
  port?: MessagePort
  frame?: HTMLIFrameElement
}

export function cancelled() {
  return new DOMException("保存已取消。", "AbortError")
}

export function waitForRegistration(
  registration: Promise<ServiceWorkerRegistration>,
  signal: AbortSignal
) {
  return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", aborted)
    }
    const aborted = () => {
      cleanup()
      reject(cancelled())
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("流式保存初始化超时，请重试。"))
    }, 15000)
    signal.addEventListener("abort", aborted, { once: true })
    // Browser registration itself cannot be aborted. Settling this wait keeps
    // a late result from starting a cancelled or expired download.
    registration.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) aborted()
  })
}

export function waitForActivation(worker: ServiceWorker, signal: AbortSignal) {
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

export function waitForPort(
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
