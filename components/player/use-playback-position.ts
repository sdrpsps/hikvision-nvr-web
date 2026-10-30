"use client"

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import type { LiveStream, Preview, PlaybackStatus } from "@/shared/contracts"
import {
  playbackInstant,
  playbackOffset,
  type PlaybackTimeRequest,
} from "@/lib/playback-clock"

type PositionOptions = {
  videoRef: RefObject<HTMLVideoElement | null>
  session: LiveStream | Preview
  live: boolean
  playbackStatus?: PlaybackStatus
  requestedTime?: PlaybackTimeRequest
  onPlaybackTimeChange?: (at: string | undefined) => void
  onError: (message: string) => void
  reportError: (message: string, operation: string) => void
}

export function usePlaybackPosition({
  videoRef,
  session,
  live,
  playbackStatus,
  requestedTime,
  onPlaybackTimeChange,
  onError,
  reportError,
}: PositionOptions) {
  const [position, setPosition] = useState(0)
  const [historyReady, setHistoryReady] = useState(false)
  const [duration, setDuration] = useState(0)
  const recorded = "durationSeconds" in session ? session : undefined
  const mediaStart = recorded?.mediaStartAt ?? recorded?.fileRange?.startAt
  const serverSeek = recorded?.source === "shttp"
  const [initialOffset] = useState(() =>
    requestedTime && mediaStart
      ? Math.max(0, playbackOffset(requestedTime.at, mediaStart))
      : (recorded?.startOffsetSeconds ?? 0)
  )
  const lastRequest = useRef(requestedTime?.revision)
  const resumeAfterSeek = useRef(initialOffset > 0)
  const initialSeek = useRef(initialOffset > 0)
  const [pendingSeek, setPendingSeek] = useState<number | null>(
    initialOffset > 0 ? initialOffset : null
  )
  const [seekMode, setSeekMode] = useState<"timeline" | "step">("timeline")
  const seekTarget = useRef<number | null>(
    initialOffset > 0 ? initialOffset : null
  )
  const totalDuration = playbackStatus?.complete
    ? (playbackStatus.totalDurationSeconds ?? playbackStatus.durationSeconds)
    : recorded?.totalDurationSeconds
  const availableDuration = Math.max(
    recorded?.durationSeconds ?? 0,
    playbackStatus?.durationSeconds ?? 0,
    duration
  )
  const publishPosition = useCallback(
    (seconds: number) => {
      if (serverSeek && requestedTime?.revision !== lastRequest.current) return
      setPosition(seconds)
      onPlaybackTimeChange?.(
        mediaStart ? playbackInstant(mediaStart, seconds) : undefined
      )
    },
    [mediaStart, onPlaybackTimeChange, requestedTime?.revision, serverSeek]
  )
  const cancelSeek = () => {
    if (initialSeek.current) {
      onError("所选时间的定位已取消，请重新播放。")
      return
    }
    initialSeek.current = false
    resumeAfterSeek.current = false
    seekTarget.current = null
    setPendingSeek(null)
    if (videoRef.current) publishPosition(videoRef.current.currentTime)
  }
  const finishSeek = useCallback(() => {
    const element = videoRef.current,
      target = seekTarget.current
    if (
      !element ||
      target === null ||
      element.seeking ||
      Math.abs(element.currentTime - target) > 0.05 ||
      element.readyState < 2
    )
      return
    initialSeek.current = false
    seekTarget.current = null
    setPendingSeek(null)
    setHistoryReady(true)
    publishPosition(element.currentTime)
    if (resumeAfterSeek.current) {
      resumeAfterSeek.current = false
      void element
        .play()
        .catch(() => reportError("播放未能开始，请点击播放。", "play"))
    }
  }, [publishPosition, reportError, videoRef])
  const applyPendingSeek = useCallback(() => {
    const element = videoRef.current,
      target = seekTarget.current
    if (!element || target === null) return
    if (totalDuration !== undefined && target >= totalDuration) {
      if (initialSeek.current) {
        onError("所选起点超出实际文件范围，请刷新录像后重试。")
        return
      }
      seekTarget.current = null
      setPendingSeek(null)
      publishPosition(element.currentTime)
      reportError(
        `目标超出录像范围，文件总时长为 ${mediaTime(totalDuration)}。`,
        "seek"
      )
      return
    }
    if (
      Number.isNaN(element.duration) ||
      (Number.isFinite(element.duration) && target > element.duration)
    )
      return
    let seekable = false
    for (let index = 0; index < element.seekable.length; index++)
      if (
        target >= element.seekable.start(index) &&
        target <= element.seekable.end(index)
      )
        seekable = true
    if (!seekable) return
    try {
      if (!element.seeking && Math.abs(element.currentTime - target) > 0.05)
        element.currentTime = target
      finishSeek()
    } catch {
      seekTarget.current = null
      setPendingSeek(null)
      reportError("暂时无法跳转，请稍后重试。", "seek")
    }
  }, [
    totalDuration,
    reportError,
    onError,
    finishSeek,
    publishPosition,
    videoRef,
  ])
  const requestSeek = useCallback(
    (seconds: number, mode: "timeline" | "step" = "timeline") => {
      if (!Number.isFinite(seconds) || seconds < 0) return
      resumeAfterSeek.current = mode === "timeline"
      if (mode === "timeline") {
        videoRef.current?.pause()
        onPlaybackTimeChange?.(undefined)
      }
      setSeekMode(mode)
      seekTarget.current = seconds
      setPendingSeek(seconds)
      applyPendingSeek()
    },
    [applyPendingSeek, onPlaybackTimeChange, videoRef]
  )
  const stepSeek = useCallback(
    (delta: number) => {
      const element = videoRef.current
      if (
        live ||
        !historyReady ||
        !element ||
        !Number.isFinite(delta) ||
        (seekTarget.current !== null && resumeAfterSeek.current)
      )
        return
      const current = seekTarget.current ?? element.currentTime
      const end = totalDuration ?? element.duration
      const target = Math.max(
        0,
        Math.min(
          current + delta,
          Number.isFinite(end) ? Math.max(0, end - 0.001) : Infinity
        )
      )
      if (Math.abs(target - current) < 0.001) return
      let available = false
      for (let index = 0; index < element.seekable.length; index++) {
        if (
          target >= element.seekable.start(index) &&
          target <= element.seekable.end(index)
        )
          available = true
      }
      if (!available) {
        reportError(
          "目标超出当前可定位范围，请等待录像读取或使用时间轴定位。",
          "step"
        )
        return
      }
      requestSeek(target, "step")
    },
    [historyReady, live, reportError, requestSeek, totalDuration, videoRef]
  )
  useEffect(() => {
    if (serverSeek) return
    if (!requestedTime || requestedTime.revision === lastRequest.current) return
    lastRequest.current = requestedTime.revision
    if (!mediaStart) return
    const seconds = playbackOffset(requestedTime.at, mediaStart)
    queueMicrotask(() => requestSeek(seconds))
  }, [requestedTime, mediaStart, requestSeek, serverSeek])
  useEffect(() => {
    if (pendingSeek === null) return
    const timer = setInterval(applyPendingSeek, 250)
    return () => clearInterval(timer)
  }, [pendingSeek, applyPendingSeek])
  const targetAvailable =
    pendingSeek === null || availableDuration > pendingSeek
  useEffect(() => {
    if (live || !targetAvailable || (historyReady && pendingSeek === null))
      return
    const timer = setTimeout(
      () => onError("等待录像画面或定位超时，请重试。"),
      30_000
    )
    return () => clearTimeout(timer)
  }, [live, targetAvailable, historyReady, pendingSeek, onError])
  useEffect(() => {
    const frame = requestAnimationFrame(applyPendingSeek)
    return () => cancelAnimationFrame(frame)
  }, [applyPendingSeek, availableDuration])
  return {
    position,
    historyReady,
    historyLoading:
      !historyReady || (pendingSeek !== null && seekMode === "timeline"),
    setHistoryReady,
    setDuration,
    initialOffset,
    pendingSeek,
    seekTarget,
    totalDuration,
    publishPosition,
    cancelSeek,
    applyPendingSeek,
    stepSeek,
  }
}

function mediaTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const clock = `${String(minutes % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
  return minutes >= 60
    ? `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${clock}`
    : clock
}
