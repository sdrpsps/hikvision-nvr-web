"use client"

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type CSSProperties,
} from "react"
import {
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
  LocateIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from "@/components/ui/popover"
import { useFullscreenContainer } from "@/hooks/use-fullscreen-container"
import { useStreamAudio } from "@/hooks/use-stream-api"
import { PlaybackRate } from "@/components/playback-rate"
import { LocalLiveAudio } from "@/lib/live-audio"
import type { LiveStream, Preview, PlaybackStatus } from "@/shared/contracts"
import { ClipExport, type ClipSource } from "@/components/clip-export"
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
  playbackControls,
  initialPreferences,
  onPreferencesChange,
  onEnded,
  playbackStatus,
  clipSource,
  liveTrack,
}: {
  session: LiveStream | Preview
  live?: boolean
  onError: (message: string) => void
  actions?: ReactNode
  frame: RefObject<HTMLDivElement | null>
  playbackControls?: ReactNode
  initialPreferences?: PlaybackPreferences
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
  onEnded?: () => void
  playbackStatus?: PlaybackStatus
  clipSource?: ClipSource
  liveTrack?: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const loadAudio = useStreamAudio(session.id)
  const audio = useRef<LocalLiveAudio | null>(null)
  const ptsOffset = useRef<number | undefined>(undefined)
  const [sound, setSound] = useState(false)
  const [paused, setPaused] = useState(true)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [pendingSeek, setPendingSeek] = useState<number | null>(null)
  const seekTarget = useRef<number | null>(null)
  const [scrub, setScrub] = useState<{ seconds: number; duration: number }>()
  const [locateOpen, setLocateOpen] = useState(false)
  const [locateInput, setLocateInput] = useState("")
  const [locateError, setLocateError] = useState("")
  const locateId = useId()
  const portalContainer = useFullscreenContainer(frame)
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
  const recorded = "durationSeconds" in session ? session : undefined
  const totalDuration = playbackStatus?.complete
    ? (playbackStatus.totalDurationSeconds ?? playbackStatus.durationSeconds)
    : recorded?.totalDurationSeconds
  const availableDuration = Math.max(
    recorded?.durationSeconds ?? 0,
    playbackStatus?.durationSeconds ?? 0,
    duration
  )
  const estimate = recorded?.estimatedDurationSeconds
  // An estimate that media has already exceeded is no longer a useful scale.
  const timelineDuration =
    totalDuration ??
    (estimate && availableDuration <= estimate + 1 ? estimate : 0)
  const sliderDuration = scrub?.duration ?? timelineDuration
  const cancelSeek = () => {
    seekTarget.current = null
    setPendingSeek(null)
  }
  const applyPendingSeek = useCallback(() => {
    const element = video.current,
      target = seekTarget.current
    if (!element || target === null) return
    if (totalDuration !== undefined && target > totalDuration) {
      seekTarget.current = null
      setPendingSeek(null)
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
      element.currentTime = target
      setPosition(target)
      seekTarget.current = null
      setPendingSeek(null)
    } catch {
      seekTarget.current = null
      setPendingSeek(null)
      reportError("暂时无法跳转，请稍后重试。", "seek")
    }
  }, [totalDuration, reportError])
  function requestSeek(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return
    seekTarget.current = seconds
    setPendingSeek(seconds)
    applyPendingSeek()
  }
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
    const fail = () => {
      if (disposed || failed) return
      failed = true
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
  }, [session, live, onError, reportError])
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
  return (
    <div className="video-surface" ref={frame}>
      <SaveFullscreenActivity />
      {live && liveTrack && <LiveRecordingIndicator track={liveTrack} />}
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
          if (!live) setPosition(event.currentTarget.currentTime)
        }}
        onDurationChange={(event) => {
          const seconds = event.currentTarget.duration
          if (!live)
            setDuration(Number.isFinite(seconds) && seconds > 0 ? seconds : 0)
          applyPendingSeek()
        }}
        onProgress={applyPendingSeek}
        onLoadedMetadata={applyPendingSeek}
        onCanPlay={applyPendingSeek}
        onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
      />
      {!live && (
        <>
          <div className="playback-timeline">
            <span>{mediaTime(scrub?.seconds ?? position)}</span>
            <div className="playback-seek-track">
              <Slider
                className="playback-seek-slider"
                style={
                  {
                    "--playback-read-percent": `${sliderDuration ? Math.min(100, (availableDuration / sliderDuration) * 100) : 0}%`,
                    "--playback-position-percent": `${sliderDuration ? Math.min(100, (position / sliderDuration) * 100) : 0}%`,
                  } as CSSProperties
                }
                aria-label="播放进度"
                getAriaValueText={(_formatted, seconds) => mediaTime(seconds)}
                value={[
                  Math.min(
                    scrub?.seconds ?? pendingSeek ?? position,
                    sliderDuration || 0
                  ),
                ]}
                min={0}
                max={sliderDuration || 1}
                step={0.1}
                disabled={!sliderDuration}
                onValueChange={(value) => {
                  const seconds = Array.isArray(value) ? value[0] : value
                  if (Number.isFinite(seconds))
                    setScrub({ seconds, duration: sliderDuration })
                }}
                onValueCommitted={(value) => {
                  const seconds = Array.isArray(value) ? value[0] : value
                  setScrub(undefined)
                  requestSeek(seconds)
                }}
              />
              {pendingSeek !== null && sliderDuration > 0 && (
                <span
                  className="playback-seek-target"
                  aria-hidden="true"
                  style={{
                    left: `${Math.min(100, (position / sliderDuration) * 100)}%`,
                  }}
                />
              )}
            </div>
            <span>
              {timelineDuration
                ? `${totalDuration === undefined ? "约 " : ""}${mediaTime(Math.round(timelineDuration))}`
                : "时长确认中"}
            </span>
            <Popover
              open={locateOpen}
              onOpenChange={(open) => {
                setLocateOpen(open)
                if (open) {
                  setLocateInput(mediaTime(position))
                  setLocateError("")
                }
              }}
            >
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="sm" aria-label="定位时间" />
                }
              >
                <LocateIcon data-icon="inline-start" />
                定位
              </PopoverTrigger>
              <PopoverContent
                container={portalContainer}
                side="top"
                align="end"
              >
                <PopoverTitle>定位到文件内时间</PopoverTitle>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    const seconds = parseMediaTime(locateInput)
                    if (seconds === undefined) {
                      setLocateError("请输入分:秒或时:分:秒，例如 01:20:00。")
                      return
                    }
                    if (
                      totalDuration !== undefined &&
                      seconds > totalDuration
                    ) {
                      setLocateError(
                        `目标超出录像范围，文件总时长为 ${mediaTime(totalDuration)}。`
                      )
                      return
                    }
                    requestSeek(seconds)
                    setLocateOpen(false)
                  }}
                >
                  <FieldGroup className="gap-3">
                    <Field data-invalid={!!locateError}>
                      <FieldLabel htmlFor={locateId}>文件内时间</FieldLabel>
                      <Input
                        id={locateId}
                        aria-invalid={!!locateError}
                        placeholder="01:20:00"
                        value={locateInput}
                        onChange={(event) =>
                          setLocateInput(event.currentTarget.value)
                        }
                      />
                      <FieldDescription>
                        从文件开头计算（分:秒 / 时:分:秒）
                      </FieldDescription>
                    </Field>
                    {locateError && (
                      <p role="alert" className="text-sm text-destructive">
                        {locateError}
                      </p>
                    )}
                    <Button type="submit" size="sm">
                      跳转
                    </Button>
                  </FieldGroup>
                </form>
              </PopoverContent>
            </Popover>
          </div>
          <div className="playback-read-status">
            <p role="status">
              {pendingSeek !== null
                ? `正在读取至 ${mediaTime(pendingSeek)}，已读取至 ${mediaTime(availableDuration)}`
                : totalDuration === undefined
                  ? `已读取至 ${mediaTime(availableDuration)}`
                  : ""}
            </p>
            {pendingSeek !== null && (
              <Button variant="ghost" size="xs" onClick={cancelSeek}>
                取消定位
              </Button>
            )}
          </div>
        </>
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
                  void element.play().catch(() => {
                    reportError("播放未能开始，请再次点击播放。", "play")
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
          {playbackControls}
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

function parseMediaTime(value: string) {
  const match = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim())
  if (!match) return undefined
  return match[3] === undefined
    ? Number(match[1]) * 60 + Number(match[2])
    : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}
