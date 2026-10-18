"use client"

import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { MaximizeIcon, Volume2Icon, VolumeXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { LocalLiveAudio } from "@/lib/live-audio"
import type { LiveStream } from "@/shared/contracts"

export function HlsVideo({
  session,
  live = false,
  onReady,
  onError,
  actions,
}: {
  session: LiveStream
  live?: boolean
  onReady: () => void
  onError: (message: string) => void
  actions?: ReactNode
}) {
  const video = useRef<HTMLVideoElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const audio = useRef<LocalLiveAudio | null>(null)
  const ptsOffset = useRef<number | undefined>(undefined)
  const [sound, setSound] = useState(false)
  const [audioError, setAudioError] = useState("")
  const soundId = useId()
  useEffect(() => {
    const element = video.current
    if (!element) return
    let disposed = false
    let hls: import("hls.js").default | undefined
    const fail = () => {
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
      element.pause()
      element.removeAttribute("src")
      element.load()
    }
  }, [session, live, onError])
  async function toggleSound() {
    if (audio.current) {
      audio.current.close()
      audio.current = null
      setSound(false)
      return
    }
    if (!video.current) return
    setAudioError("")
    const player = new LocalLiveAudio(
      video.current,
      session.id,
      () => ptsOffset.current,
      (message) => {
        audio.current = null
        setSound(false)
        setAudioError(message)
      }
    )
    audio.current = player
    setSound(true)
    try {
      await player.start()
    } catch {
      player.close()
      if (audio.current === player) audio.current = null
      setSound(false)
      setAudioError("浏览器尚未允许声音，请再次点击开启声音。")
    }
  }
  return (
    <div className="video-surface" ref={frame}>
      <video
        ref={video}
        className="preview-video"
        controls={!live}
        playsInline
        muted={live}
        autoPlay={live}
        preload="auto"
        aria-label={live ? "实时预览画面" : "历史录像预览"}
        onCanPlay={onReady}
      />
      {live && (
        <div className="live-video-controls">
          <div className="live-controls-left">
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
      )}
      {audioError && (
        <p className="text-sm text-destructive" role="alert">
          {audioError}
        </p>
      )}
    </div>
  )
}
