import {
  LIVE_MAX_LATENCY_DURATION_COUNT,
  LIVE_SYNC_DURATION_COUNT,
} from "../shared/live-policy"

export function attachNativeLiveSync(
  video: HTMLVideoElement,
  targetDurationSeconds: number
): () => void {
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0)
    return () => {}

  let disposed = false
  let updating = false
  const recover = () => {
    if (disposed || updating) return
    try {
      if (
        video.paused ||
        video.ended ||
        video.readyState < 2 ||
        video.seeking ||
        document.visibilityState === "hidden"
      )
        return
      const ranges = video.seekable
      if (!ranges || !Number.isInteger(ranges.length) || ranges.length < 1)
        return
      const last = ranges.length - 1
      const start = ranges.start(last)
      const edge = ranges.end(last)
      const current = video.currentTime
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(edge) ||
        !Number.isFinite(current) ||
        edge <= start ||
        edge - current <=
          LIVE_MAX_LATENCY_DURATION_COUNT * targetDurationSeconds
      )
        return

      // Keep a playable lead-in; the native engine resolves keyframe decoding.
      updating = true
      video.currentTime = Math.max(
        start,
        edge - LIVE_SYNC_DURATION_COUNT * targetDurationSeconds
      )
    } catch {
      // A moving native seekable window may become unavailable between reads.
    } finally {
      updating = false
    }
  }
  const events = ["loadedmetadata", "progress", "timeupdate", "playing"]
  for (const event of events) video.addEventListener(event, recover)
  document.addEventListener("visibilitychange", recover)
  window.addEventListener("pageshow", recover)
  return () => {
    if (disposed) return
    disposed = true
    for (const event of events) video.removeEventListener(event, recover)
    document.removeEventListener("visibilitychange", recover)
    window.removeEventListener("pageshow", recover)
  }
}
