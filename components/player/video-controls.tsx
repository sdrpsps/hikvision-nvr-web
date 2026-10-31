"use client"

import { useId, type ReactNode, type RefObject } from "react"
import { MaximizeIcon, Volume2Icon, VolumeXIcon } from "lucide-react"
import { cn } from "@/lib/utils"
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
    <div
      className={cn(
        "live-video-controls z-0 flex min-w-0 items-center justify-between gap-2",
        live
          ? "pointer-events-auto absolute inset-x-0 bottom-0 flex-nowrap bg-card/94 px-1.5 py-1.5 opacity-0 backdrop-blur-md transition-opacity duration-100 group-hover/window:opacity-100 group-has-[:focus-visible]/window:opacity-100 group-data-[live-starting=true]/video:z-[1] contrast-more:border-t contrast-more:border-foreground contrast-more:bg-card contrast-more:backdrop-blur-none [@media(hover:none)]:opacity-100 [@media(prefers-reduced-transparency:reduce)]:bg-card [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none"
          : "flex-wrap gap-x-3 gap-y-2 px-2.5 py-2",
        "video-fullscreen:pointer-events-auto video-fullscreen:static video-fullscreen:shrink-0 video-fullscreen:bg-card video-fullscreen:px-4 video-fullscreen:py-2 video-fullscreen:opacity-100",
        !live &&
          "video-fullscreen:col-start-1 video-fullscreen:row-start-3 video-fullscreen:w-full"
      )}
    >
      <div
        className={cn(
          "live-controls-left flex min-w-0 shrink-0 items-center gap-2",
          !live && "flex-wrap @max-[400px]:contents"
        )}
      >
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
        <div className="sound-control flex shrink-0 items-center gap-2 px-1 @max-[400px]:gap-1 @max-[400px]:px-0">
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
              <Volume2Icon aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <VolumeXIcon aria-hidden="true" className="size-4 shrink-0" />
            )}
            <span className="@max-[400px]:hidden">声音</span>
          </Label>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="@max-[400px]:w-7 @max-[400px]:gap-0 @max-[400px]:px-0"
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
          <span className="@max-[400px]:hidden">全屏</span>
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
