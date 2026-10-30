"use client"

import { useId, type ReactNode, type RefObject } from "react"
import { MaximizeIcon, Volume2Icon, VolumeXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { PlaybackRate } from "@/components/playback-rate"
import { ClipExport, type ClipSource } from "@/components/clip-export"
import type { PlaybackPreferences } from "./types"
import { PlaybackStep } from "./playback-step"

type ControlsProps = {
  live: boolean
  videoRef: RefObject<HTMLVideoElement | null>
  frame: RefObject<HTMLDivElement | null>
  pendingSeek: number | null
  cancelSeek: () => void
  rate: number
  setRate: (rate: number) => void
  sound: boolean
  toggleSound: () => void
  position: number
  totalDuration?: number
  clipSource?: ClipSource
  actions?: ReactNode
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
  reportError: (message: string, operation: string) => void
  stepSeek: (delta: number) => void
  initialStepSeconds?: number
}

export function VideoControls({
  live,
  videoRef,
  frame,
  pendingSeek,
  cancelSeek,
  rate,
  setRate,
  sound,
  toggleSound,
  position,
  totalDuration,
  clipSource,
  actions,
  onPreferencesChange,
  reportError,
  stepSeek,
  initialStepSeconds,
}: ControlsProps) {
  const soundId = useId()
  return (
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
              if (!videoRef.current) return false
              try {
                videoRef.current.playbackRate = next
                setRate(videoRef.current.playbackRate)
                onPreferencesChange?.({ rate: videoRef.current.playbackRate })
                return videoRef.current.playbackRate === next
              } catch {
                return false
              }
            }}
          />
        )}
        {!live && (
          <PlaybackStep
            container={frame}
            onStep={stepSeek}
            initialValue={initialStepSeconds}
            onPreferencesChange={onPreferencesChange}
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
          <Label htmlFor={soundId} title={sound ? "声音已开启" : "声音已静音"}>
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
        {!live && clipSource && (
          <ClipExport
            source={clipSource}
            position={position}
            duration={totalDuration}
            container={frame}
          />
        )}
      </div>
      {actions}
    </div>
  )
}
