"use client"

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { PlaybackRate } from "@/components/playback-rate"
import { LocalLiveAudio } from "@/lib/live-audio"
import type { LiveStream } from "@/shared/contracts"

export type PlaybackPreferences = { rate: number; sound: boolean }

export function HlsVideo({
  session,
  live = false,
  onError,
  actions,
  initialPreferences,
  onPreferencesChange,
  onEnded,
}: {
  session: LiveStream
  live?: boolean
  onError: (message: string) => void
  actions?: ReactNode
  initialPreferences?: PlaybackPreferences
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
  onEnded?: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const audio = useRef<LocalLiveAudio | null>(null)
  const ptsOffset = useRef<number | undefined>(undefined)
  const [sound, setSound] = useState(false)
  const [audioError, setAudioError] = useState("")
  const [paused, setPaused] = useState(true)
  const [playError, setPlayError] = useState("")
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(initialPreferences?.rate ?? 1)
  const preferences = useRef(initialPreferences)
  const soundId = useId()
  useEffect(() => {
    const element = video.current
    if (!element) return
    let disposed = false
    let hls: import("hls.js").default | undefined
    const fail = () => {
      if (disposed) return
      audio.current?.close()
      audio.current = null
      setSound(false)
      element.pause()
      hls?.destroy()
      onError(
        `画面加载失败，请重新打开，并确认浏览器支持 ${session.codec === "hevc" ? "H.265 / HEVC" : "H.264"}。`
      )
    }
    element.addEventListener("error", fail)
    const restoreRate = () => {
      if (!live && preferences.current) {
        try {
          element.playbackRate = preferences.current.rate
        } catch {
          setPlayError("浏览器未能恢复倍速，请重新选择。")
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
          if (disposed) return
          if (!Hls.isSupported()) {
            if (nativeHls) {
              element.src = session.playlistUrl
              return
            }
            onError("此浏览器不支持 HLS 播放，请使用新版 Safari 或 Chrome。")
            return
          }
          hls = new Hls({
            enableWorker: true,
            maxBufferLength: live ? 12 : 35,
            backBufferLength: live ? 0 : 35,
            startPosition: live ? -1 : 0,
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
          if (!disposed) onError("播放器加载失败，请重试。")
        })
    return () => {
      disposed = true
      audio.current?.close()
      audio.current = null
      hls?.destroy()
      element.removeEventListener("error", fail)
      element.removeEventListener("loadedmetadata", restoreRate)
      element.pause()
      element.removeAttribute("src")
      element.load()
    }
  }, [session, live, onError])
  const enableSound = useCallback(async () => {
    if (audio.current) return
    if (!video.current) return
    setAudioError("")
    let player: LocalLiveAudio | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      player = new LocalLiveAudio(
        video.current,
        session.id,
        () => ptsOffset.current,
        (message) => {
          audio.current = null
          setSound(false)
          onPreferencesChange?.({ sound: false })
          setAudioError(message)
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
      setAudioError("浏览器尚未允许声音，请再次点击开启声音。")
    } finally {
      clearTimeout(timeout)
    }
  }, [session.id, live, onPreferencesChange])
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
  return (
    <div className="video-surface" ref={frame}>
      <video
        ref={video}
        className="preview-video"
        playsInline
        muted
        autoPlay
        preload="auto"
        aria-label={live ? "实时预览画面" : "历史录像预览"}
        onPlay={() => {
          setPaused(false)
          setPlayError("")
        }}
        onPause={() => setPaused(true)}
        onEnded={(event) => {
          if (!event.currentTarget.ended) return
          setPaused(true)
          onEnded?.()
        }}
        onTimeUpdate={(event) => {
          if (!live) setPosition(event.currentTarget.currentTime)
        }}
        onDurationChange={(event) => {
          const seconds = event.currentTarget.duration
          if (!live)
            setDuration(Number.isFinite(seconds) && seconds > 0 ? seconds : 0)
        }}
        onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
      />
      {!live && (
        <div className="playback-timeline">
          <span>{mediaTime(position)}</span>
          <Slider
            aria-label="播放进度"
            value={[Math.min(position, duration)]}
            min={0}
            max={duration || 1}
            step={0.1}
            disabled={!duration}
            onValueChange={(value) => {
              if (!video.current || !duration) return
              const seconds = Array.isArray(value) ? value[0] : value
              if (!Number.isFinite(seconds)) return
              try {
                video.current.currentTime = Math.max(
                  0,
                  Math.min(seconds, duration)
                )
                setPosition(video.current.currentTime)
              } catch {
                setPlayError("暂时无法跳转，请稍后重试。")
              }
            }}
          />
          <span>{mediaTime(Math.round(duration))}</span>
        </div>
      )}
      <div className="live-video-controls">
        <div className="live-controls-left">
          {!live && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={paused ? "播放录像" : "暂停录像"}
              title={paused ? "播放录像" : "暂停录像"}
              onClick={() => {
                const element = video.current
                if (!element) return
                if (element.paused) {
                  setPlayError("")
                  void element.play().catch(() => {
                    setPlayError("播放未能开始，请再次点击播放。")
                  })
                } else element.pause()
              }}
            >
              {paused ? (
                <PlayIcon data-icon="inline-start" />
              ) : (
                <PauseIcon data-icon="inline-start" />
              )}
              <span className="control-label">{paused ? "播放" : "暂停"}</span>
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
            onClick={() => {
              void frame.current
                ?.requestFullscreen()
                .catch(() => setAudioError("浏览器未能进入全屏，请重试。"))
            }}
          >
            <MaximizeIcon data-icon="inline-start" />
            <span className="control-label">全屏</span>
          </Button>
        </div>
        {actions}
      </div>
      {playError && (
        <p className="text-sm text-destructive" role="alert">
          {playError}
        </p>
      )}
      {audioError && (
        <p className="text-sm text-destructive" role="alert">
          {audioError}
        </p>
      )}
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
