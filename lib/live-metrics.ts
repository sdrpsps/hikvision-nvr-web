import type { LiveStream } from "@/shared/contracts"

const requests = new WeakMap<
  LiveStream,
  { startedAt: number; readyAt: number }
>()

export function recordLiveRequest(session: LiveStream, startedAt: number) {
  requests.set(session, { startedAt, readyAt: performance.now() })
  return session
}

// Numeric, per-element diagnostics only: no pixels, source identifiers, logs or
// persistent history. A playing event is deliberately not a displayed frame.
export function observeLiveStartup(
  video: HTMLVideoElement,
  session: LiveStream,
  onStarted: () => void,
  onTimeout?: () => void
) {
  const mountedAt = performance.now()
  const request = requests.get(session)
  const startedAt = request?.startedAt ?? mountedAt
  const frameCallbackSupported =
    typeof video.requestVideoFrameCallback === "function"
  const sample = {
    server: session.startup ?? null,
    apiMs: request ? request.readyAt - startedAt : null,
    mountedMs: mountedAt - startedAt,
    playingMs: null as number | null,
    firstFrameMs: null as number | null,
    firstFrameMediaSeconds: null as number | null,
    frameCallbackSupported,
  }
  let active = true
  let pending = true
  let callback: number | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let remainingMs = 30_000
  let visibleSince: number | undefined
  const pauseDeadline = () => {
    if (visibleSince !== undefined) {
      remainingMs = Math.max(
        0,
        remainingMs - (performance.now() - visibleSince)
      )
      visibleSince = undefined
    }
    clearTimeout(timeout)
    timeout = undefined
  }
  const stopDeadline = () => {
    pauseDeadline()
    if (onTimeout) document.removeEventListener("visibilitychange", visibility)
  }
  const stop = () => {
    if (!active) return
    active = false
    stopDeadline()
    video.removeEventListener("playing", playing)
    if (callback !== undefined) video.cancelVideoFrameCallback(callback)
    callback = undefined
    delete video.dataset.liveStartup
  }
  const started = () => {
    if (!active || !pending) return
    pending = false
    stopDeadline()
    onStarted()
  }
  const visibility = () => {
    if (!active || !pending || !onTimeout) return
    if (document.visibilityState === "hidden") {
      pauseDeadline()
      return
    }
    if (visibleSince !== undefined) return
    visibleSince = performance.now()
    timeout = setTimeout(() => {
      if (!active || !pending) return
      // rVFC may stop in hidden tabs; only visible waiting consumes the budget.
      if (document.visibilityState === "hidden") {
        pauseDeadline()
        return
      }
      stop()
      onTimeout()
    }, remainingMs)
  }
  const publish = () => {
    video.dataset.liveStartup = JSON.stringify(sample)
  }
  const playing = () => {
    if (!active) return
    sample.playingMs ??= performance.now() - startedAt
    publish()
    if (!frameCallbackSupported) started()
  }
  const frame: VideoFrameRequestCallback = (now, metadata) => {
    callback = undefined
    if (!active || !pending) return
    if (video.paused || video.readyState < 2 || sample.playingMs === null) {
      callback = video.requestVideoFrameCallback(frame)
      return
    }
    sample.firstFrameMs = Math.max(0, now - startedAt)
    sample.firstFrameMediaSeconds = metadata.mediaTime
    publish()
    started()
  }
  video.addEventListener("playing", playing)
  if (frameCallbackSupported) callback = video.requestVideoFrameCallback(frame)
  if (onTimeout) {
    document.addEventListener("visibilitychange", visibility)
    visibility()
  }
  publish()
  return stop
}
