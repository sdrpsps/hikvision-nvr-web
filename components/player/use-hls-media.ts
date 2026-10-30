"use client"

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { useStreamAudio } from "@/hooks/use-stream-api"
import { LocalLiveAudio } from "@/lib/live-audio"
import { observeLiveStartup } from "@/lib/live-metrics"
import { attachNativeLiveSync } from "@/lib/native-live-sync"
import {
  LIVE_MAX_LATENCY_DURATION_COUNT,
  LIVE_SYNC_DURATION_COUNT,
} from "@/shared/live-policy"
import type { LiveStream, Preview } from "@/shared/contracts"
import type { PlaybackPreferences } from "./types"

type MediaOptions = {
  videoRef: RefObject<HTMLVideoElement | null>
  session: LiveStream | Preview
  live: boolean
  initialOffset: number
  initialPreferences?: PlaybackPreferences
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
  onError: (message: string) => void
  reportError: (message: string, operation: string) => void
  onLiveStarted: () => void
}

// Source playback and local audio own one media lifecycle: PTS alignment,
// restored preferences and failure/unmount cleanup stay together here.
export function useHlsMedia({
  videoRef,
  session,
  live,
  initialOffset,
  initialPreferences,
  onPreferencesChange,
  onError,
  reportError,
  onLiveStarted,
}: MediaOptions) {
  const loadAudio = useStreamAudio(session.id)
  const audio = useRef<LocalLiveAudio | null>(null)
  const ptsOffset = useRef<number | undefined>(undefined)
  const preferences = useRef(initialPreferences)
  const [sound, setSound] = useState(false)
  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    let disposed = false
    let failed = false
    let hls: import("hls.js").default | undefined
    let stopNativeSync: (() => void) | undefined
    let stopObservation: (() => void) | undefined
    const fail = (
      message = `画面加载失败，请重新打开，并确认浏览器支持 ${session.codec === "hevc" ? "H.265 / HEVC" : "H.264"}。`
    ) => {
      if (disposed || failed) return
      failed = true
      stopNativeSync?.()
      stopObservation?.()
      audio.current?.close()
      audio.current = null
      setSound(false)
      element.pause()
      hls?.destroy()
      onError(message)
    }
    const onMediaError = () => fail()
    element.addEventListener("error", onMediaError)
    if (live) {
      stopObservation = observeLiveStartup(
        element,
        session,
        onLiveStarted,
        () => fail("等待实时画面缓冲超时，请重新连接。")
      )
    }
    const restoreRate = () => {
      if (!live && preferences.current) {
        try {
          element.playbackRate = preferences.current.rate
        } catch {
          reportError("浏览器未能恢复倍速，请重新选择。", "rate")
        }
      }
    }
    restoreRate()
    element.addEventListener("loadedmetadata", restoreRate)
    const nativeHls = !!element.canPlayType("application/vnd.apple.mpegurl")
    const attachNativeSource = () => {
      if (live)
        stopNativeSync = attachNativeLiveSync(
          element,
          "targetDurationSeconds" in session
            ? (session.targetDurationSeconds ?? 3)
            : 3
        )
      element.src = session.playlistUrl
    }
    // Safari uses native HLS. Chrome can advertise HLS support while rejecting
    // the rolling HEVC playlist; use its MediaSource path through hls.js.
    if (nativeHls && navigator.vendor.includes("Apple")) attachNativeSource()
    else
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (disposed || failed) return
          if (!Hls.isSupported()) {
            if (nativeHls) {
              attachNativeSource()
              return
            }
            fail("此浏览器不支持 HLS 播放，请使用新版 Safari 或 Chrome。")
            return
          }
          hls = new Hls({
            enableWorker: true,
            maxBufferLength: live ? 12 : 35,
            // Keep prior GOPs when short fragments share decoding dependencies.
            backBufferLength: live ? 12 : 35,
            startPosition: live ? -1 : initialOffset,
            ...(live && {
              lowLatencyMode: false,
              liveSyncDurationCount: LIVE_SYNC_DURATION_COUNT,
              liveMaxLatencyDurationCount: LIVE_MAX_LATENCY_DURATION_COUNT,
            }),
          })
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) fail()
          })
          hls.on(Hls.Events.INIT_PTS_FOUND, (_event, data) => {
            ptsOffset.current = data.initPTS / data.timescale
          })
          hls.loadSource(session.playlistUrl)
          hls.attachMedia(element)
        })
        .catch(() => {
          if (!disposed) fail("播放器加载失败，请重试。")
        })
    return () => {
      disposed = true
      stopNativeSync?.()
      stopObservation?.()
      audio.current?.close()
      audio.current = null
      hls?.destroy()
      element.removeEventListener("error", onMediaError)
      element.removeEventListener("loadedmetadata", restoreRate)
      element.pause()
      element.removeAttribute("src")
      element.load()
    }
  }, [
    session,
    live,
    onError,
    reportError,
    onLiveStarted,
    initialOffset,
    videoRef,
  ])
  const enableSound = useCallback(async () => {
    if (audio.current) return
    if (!videoRef.current) return
    let player: LocalLiveAudio | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      player = new LocalLiveAudio(
        videoRef.current,
        loadAudio,
        () => ptsOffset.current,
        (message) => {
          audio.current = null
          setSound(false)
          onPreferencesChange?.({ sound: false })
          reportError(message, "audio")
        },
        !live
      )
      audio.current = player
      setSound(true)
      await Promise.race([
        player.start(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Audio activation timed out")),
            3000
          )
        }),
      ])
    } catch {
      player?.close()
      if (player && audio.current !== player) return
      audio.current = null
      setSound(false)
      onPreferencesChange?.({ sound: false })
      reportError("浏览器尚未允许声音，请再次点击开启声音。", "audio")
    } finally {
      clearTimeout(timeout)
    }
  }, [loadAudio, live, onPreferencesChange, reportError, videoRef])
  useEffect(() => {
    if (!live && preferences.current?.sound) void enableSound()
  }, [enableSound, live])
  function toggleSound() {
    if (audio.current) {
      audio.current.close()
      audio.current = null
      setSound(false)
      onPreferencesChange?.({ sound: false })
    } else {
      onPreferencesChange?.({ sound: true })
      void enableSound()
    }
  }
  return { sound, toggleSound }
}
