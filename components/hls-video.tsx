"use client"

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import {
  LoaderCircleIcon,
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useStreamAudio } from "@/hooks/use-stream-api"
import { PlaybackRate } from "@/components/playback-rate"
import { LocalLiveAudio } from "@/lib/live-audio"
import type { LiveStream, Preview, PlaybackStatus } from "@/shared/contracts"
import { ClipExport, type ClipSource } from "@/components/clip-export"
import {
  playbackInstant,
  playbackOffset,
  type PlaybackTimeRequest,
} from "@/lib/playback-clock"
import {
  LiveRecordingIndicator,
  SaveFullscreenActivity,
} from "@/components/browser-save-provider"

export type PlaybackPreferences = { rate: number; sound: boolean }

export function HlsVideo({
  session,
  live = false,
  onError,
  actions,
  frame,
  initialPreferences,
  onPreferencesChange,
  onEnded,
  playbackStatus,
  clipSource,
  liveTrack,
  requestedTime,
  onPlaybackTimeChange,
  timeline,
}: {
  session: LiveStream | Preview
  live?: boolean
  onError: (message: string) => void
  actions?: ReactNode
  frame: RefObject<HTMLDivElement | null>
  initialPreferences?: PlaybackPreferences
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
  onEnded?: () => void
  playbackStatus?: PlaybackStatus
  clipSource?: ClipSource
  liveTrack?: string
  requestedTime?: PlaybackTimeRequest
  onPlaybackTimeChange?: (at: string | undefined) => void
  timeline?: ReactNode
}) {
  const video = useRef<HTMLVideoElement>(null)
  const loadAudio = useStreamAudio(session.id)
  const audio = useRef<LocalLiveAudio | null>(null)
  const ptsOffset = useRef<number | undefined>(undefined)
  const [sound, setSound] = useState(false)
  const [paused, setPaused] = useState(true)
  const [liveStarted, setLiveStarted] = useState(false)
  const [position, setPosition] = useState(0)
  const [historyReady, setHistoryReady] = useState(false)
  const [duration, setDuration] = useState(0)
  const recorded = "durationSeconds" in session ? session : undefined
  const fileStart = recorded?.fileRange?.startAt
  const [initialOffset] = useState(() =>
    requestedTime && fileStart
      ? Math.max(0, playbackOffset(requestedTime.at, fileStart))
      : (recorded?.startOffsetSeconds ?? 0)
  )
  const lastRequest = useRef(requestedTime?.revision)
  const resumeAfterSeek = useRef(initialOffset > 0)
  const initialSeek = useRef(initialOffset > 0)
  const [pendingSeek, setPendingSeek] = useState<number | null>(
    initialOffset > 0 ? initialOffset : null
  )
  const seekTarget = useRef<number | null>(
    initialOffset > 0 ? initialOffset : null
  )
  const [rate, setRate] = useState(initialPreferences?.rate ?? 1)
  const preferences = useRef(initialPreferences)
  const soundId = useId()
  const reportError = useCallback(
    (message: string, operation: string) => {
      toast.error(message, {
        id: `media-${session.id}-${operation}`,
        description: live
          ? `${liveTrack ? `通道 ${liveTrack}` : "实时预览"} · 播放操作`
          : `${clipSource?.channelName ?? "录像"} · 录像回放`,
      })
    },
    [session.id, live, liveTrack, clipSource?.channelName]
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
      setPosition(seconds)
      onPlaybackTimeChange?.(
        fileStart ? playbackInstant(fileStart, seconds) : undefined
      )
    },
    [fileStart, onPlaybackTimeChange]
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
    if (video.current) publishPosition(video.current.currentTime)
  }
  const finishSeek = useCallback(() => {
    const element = video.current,
      target = seekTarget.current
    if (
      !element ||
      target === null ||
      element.seeking ||
      Math.abs(element.currentTime - target) > 0.5 ||
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
  }, [publishPosition, reportError])
  const applyPendingSeek = useCallback(() => {
    const element = video.current,
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
  }, [totalDuration, reportError, onError, finishSeek, publishPosition])
  const requestSeek = useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds) || seconds < 0) return
      resumeAfterSeek.current = true
      video.current?.pause()
      onPlaybackTimeChange?.(undefined)
      seekTarget.current = seconds
      setPendingSeek(seconds)
      applyPendingSeek()
    },
    [applyPendingSeek, onPlaybackTimeChange]
  )
  useEffect(() => {
    if (!requestedTime || requestedTime.revision === lastRequest.current) return
    lastRequest.current = requestedTime.revision
    if (!fileStart) return
    const seconds = playbackOffset(requestedTime.at, fileStart)
    queueMicrotask(() => requestSeek(seconds))
  }, [requestedTime, fileStart, requestSeek])
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
  useEffect(() => {
    const element = video.current
    if (!element) return
    let disposed = false
    let failed = false
    let hls: import("hls.js").default | undefined
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    const clearStartup = () => {
      clearTimeout(startupTimer)
      startupTimer = undefined
    }
    const fail = (
      message = `画面加载失败，请重新打开，并确认浏览器支持 ${session.codec === "hevc" ? "H.265 / HEVC" : "H.264"}。`
    ) => {
      if (disposed || failed) return
      failed = true
      clearStartup()
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
      element.addEventListener("playing", clearStartup, { once: true })
      startupTimer = setTimeout(
        () => fail("等待实时画面缓冲超时，请重新连接。"),
        30_000
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
    // Safari uses native HLS. Chrome can advertise HLS support while rejecting
    // the rolling HEVC playlist; use its MediaSource path through hls.js.
    if (nativeHls && navigator.vendor.includes("Apple"))
      element.src = session.playlistUrl
    else
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (disposed || failed) return
          if (!Hls.isSupported()) {
            if (nativeHls) {
              element.src = session.playlistUrl
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
      clearStartup()
      audio.current?.close()
      audio.current = null
      hls?.destroy()
      element.removeEventListener("error", onMediaError)
      element.removeEventListener("playing", clearStartup)
      element.removeEventListener("loadedmetadata", restoreRate)
      element.pause()
      element.removeAttribute("src")
      element.load()
    }
  }, [session, live, onError, reportError, initialOffset])
  const enableSound = useCallback(async () => {
    if (audio.current) return
    if (!video.current) return
    let player: LocalLiveAudio | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      player = new LocalLiveAudio(
        video.current,
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
  }, [loadAudio, live, onPreferencesChange, reportError])
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
  function togglePlayback() {
    const element = video.current
    if (!element) return
    if (element.paused) {
      void element.play().catch(() => {
        reportError("播放未能开始，请再次点击播放。", "play")
      })
    } else element.pause()
  }
  return (
    <div
      className="video-surface"
      ref={frame}
      data-live-starting={live && !liveStarted}
    >
      <SaveFullscreenActivity />
      {live && liveTrack && <LiveRecordingIndicator track={liveTrack} />}
      <div className="playback-frame">
        <video
          ref={video}
          className="preview-video"
          style={{
            visibility:
              !live && (pendingSeek !== null || !historyReady)
                ? "hidden"
                : undefined,
          }}
          playsInline
          muted
          autoPlay={initialOffset === 0}
          preload="auto"
          aria-label={live ? "实时预览画面" : "历史录像预览"}
          onPlay={() => {
            setPaused(false)
          }}
          onPlaying={() => {
            if (live) setLiveStarted(true)
            else if (seekTarget.current === null) setHistoryReady(true)
          }}
          onPause={() => setPaused(true)}
          onEnded={(event) => {
            if (!event.currentTarget.ended) return
            setPaused(true)
            if (seekTarget.current !== null) {
              applyPendingSeek()
              return
            }
            onEnded?.()
          }}
          onTimeUpdate={(event) => {
            if (
              !live &&
              seekTarget.current === null &&
              !event.currentTarget.seeking &&
              event.currentTarget.readyState >= 2
            )
              publishPosition(event.currentTarget.currentTime)
          }}
          onSeeked={finishSeek}
          onDurationChange={(event) => {
            const seconds = event.currentTarget.duration
            if (!live)
              setDuration(Number.isFinite(seconds) && seconds > 0 ? seconds : 0)
            applyPendingSeek()
          }}
          onProgress={applyPendingSeek}
          onLoadedMetadata={applyPendingSeek}
          onCanPlay={(event) => {
            applyPendingSeek()
            if (!live && seekTarget.current === null) {
              setHistoryReady(true)
              publishPosition(event.currentTarget.currentTime)
            }
          }}
          onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
        />
        {!live && historyReady && pendingSeek === null && (
          <Button
            className="playback-surface-button"
            variant="ghost"
            data-paused={paused}
            aria-label={paused ? "播放录像" : "暂停录像"}
            title={paused ? "播放录像" : "暂停录像"}
            onClick={togglePlayback}
          >
            <span className="playback-center-icon" aria-hidden="true">
              {paused ? <PlayIcon /> : <PauseIcon />}
            </span>
          </Button>
        )}
        {live && !liveStarted && (
          <Empty
            className="live-startup"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <EmptyHeader>
              <LoaderCircleIcon
                className="player-loading-icon animate-spin"
                aria-hidden="true"
              />
              <EmptyTitle>正在缓冲画面</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {!live && (!historyReady || pendingSeek !== null) && (
          <Empty className="playback-startup" role="status">
            <EmptyHeader>
              <LoaderCircleIcon
                className="player-loading-icon animate-spin"
                aria-hidden="true"
              />
              <EmptyTitle>
                {pendingSeek !== null ? "正在定位所选时间" : "正在缓冲录像"}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </div>
      {timeline}
      <div className="live-video-controls">
        <div className="live-controls-left">
          {!live && pendingSeek !== null && (
            <Button variant="ghost" size="sm" onClick={cancelSeek}>
              取消定位
            </Button>
          )}
          {!live && (
            <PlaybackRate
              value={rate}
              container={frame}
              onChange={(next) => {
                if (!video.current) return false
                try {
                  video.current.playbackRate = next
                  setRate(video.current.playbackRate)
                  onPreferencesChange?.({ rate: video.current.playbackRate })
                  return video.current.playbackRate === next
                } catch {
                  return false
                }
              }}
            />
          )}
          {!live && clipSource && (
            <ClipExport
              source={clipSource}
              position={position}
              duration={totalDuration}
              container={frame}
            />
          )}
          <div className="sound-control">
            <Switch
              id={soundId}
              aria-label="声音"
              size="sm"
              checked={sound}
              onCheckedChange={(checked) => {
                if (checked !== sound) void toggleSound()
              }}
            />
            <Label
              htmlFor={soundId}
              title={sound ? "声音已开启" : "声音已静音"}
            >
              {sound ? (
                <Volume2Icon aria-hidden="true" />
              ) : (
                <VolumeXIcon aria-hidden="true" />
              )}
              <span className="control-label">声音</span>
            </Label>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="全屏"
            title="全屏"
            onClick={async () => {
              try {
                if (!frame.current?.requestFullscreen)
                  throw new Error("Fullscreen unavailable")
                await frame.current.requestFullscreen()
              } catch {
                reportError("浏览器未能进入全屏，请重试。", "fullscreen")
              }
            }}
          >
            <MaximizeIcon data-icon="inline-start" />
            <span className="control-label">全屏</span>
          </Button>
        </div>
        {actions}
      </div>
    </div>
  )
}

function mediaTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const clock = `${String(minutes % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
  return minutes >= 60
    ? `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${clock}`
    : clock
}
