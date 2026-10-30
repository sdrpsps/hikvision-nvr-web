"use client"

import {
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { toast } from "sonner"
import type { LiveStream, Preview, PlaybackStatus } from "@/shared/contracts"
import type { ClipSource } from "@/components/clip-export"
import type { PlaybackTimeRequest } from "@/lib/playback-clock"
import { playbackOffset } from "@/lib/playback-clock"
import {
  LiveRecordingIndicator,
  SaveFullscreenActivity,
} from "@/components/browser-save-provider"
import type { PlaybackPreferences } from "./player/types"
import { usePlaybackPosition } from "./player/use-playback-position"
import { useHlsMedia } from "./player/use-hls-media"
import { PlaybackOverlay } from "./player/playback-overlay"
import { VideoControls } from "./player/video-controls"

export type { PlaybackPreferences } from "./player/types"

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
  const [paused, setPaused] = useState(true)
  const [liveStarted, setLiveStarted] = useState(false)
  const onLiveStarted = useCallback(() => setLiveStarted(true), [])
  const [rate, setRate] = useState(initialPreferences?.rate ?? 1)
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
  const {
    position,
    historyLoading,
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
  } = usePlaybackPosition({
    videoRef: video,
    session,
    live,
    playbackStatus,
    requestedTime,
    onPlaybackTimeChange,
    onError,
    reportError,
  })
  const { sound, toggleSound } = useHlsMedia({
    videoRef: video,
    session,
    live,
    initialOffset,
    initialPreferences,
    onPreferencesChange,
    onError,
    reportError,
    onLiveStarted,
  })
  const recording = "durationSeconds" in session ? session : undefined
  const serverSeek = recording?.source === "shttp"
  const fileOffset =
    recording?.mediaStartAt && recording.fileRange
      ? playbackOffset(recording.mediaStartAt, recording.fileRange.startAt)
      : 0
  const fileDuration =
    recording?.fileDurationSeconds ?? (serverSeek ? undefined : totalDuration)
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
            visibility: !live && historyLoading ? "hidden" : undefined,
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
            if (!live && seekTarget.current === null) setHistoryReady(true)
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
          onSeeked={applyPendingSeek}
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
        <PlaybackOverlay
          live={live}
          liveStarted={liveStarted}
          historyLoading={historyLoading}
          pendingSeek={pendingSeek}
          paused={paused}
          togglePlayback={togglePlayback}
        />
      </div>
      {timeline}
      <VideoControls
        live={live}
        videoRef={video}
        frame={frame}
        pendingSeek={historyLoading ? pendingSeek : null}
        cancelSeek={cancelSeek}
        rate={rate}
        setRate={setRate}
        sound={sound}
        toggleSound={toggleSound}
        position={position + fileOffset}
        totalDuration={fileDuration}
        clipSource={
          clipSource
            ? { ...clipSource, fileStartAt: recording?.fileRange?.startAt }
            : undefined
        }
        actions={actions}
        onPreferencesChange={onPreferencesChange}
        reportError={reportError}
        stepSeek={stepSeek}
        initialStepSeconds={initialPreferences?.stepSeconds}
      />
    </div>
  )
}
