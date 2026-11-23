"use client"

import {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  LiveRecordingIndicator,
  SaveFullscreenActivity,
} from "@/components/browser-save-provider"
import { HlsVideo } from "@/components/hls-video"
import { VideoWall } from "@/components/video-wall"
import type {
  StreamSource,
  PlaybackOptions,
  StreamPlayerHandle,
} from "./player/types"
import { useFullscreenControls } from "./player/use-fullscreen-controls"
import { useStreamSession } from "./player/use-stream-session"
import { RestartAction } from "./player/restart-action"
import { StreamIdle } from "./player/stream-idle"

export type { StreamPlayerHandle } from "./player/types"

export function PreviewPlayer(
  props: {
    track: string
    date: string
    segmentId: string
  } & PlaybackOptions
) {
  return (
    <div className="playback-player mx-auto w-full min-w-0">
      <VideoWall
        count={1}
        label="录像预览窗口"
        renderWindow={() => (
          <section
            className="live-window @container relative flex w-full min-w-0 flex-col overflow-hidden rounded-sm border bg-card"
            aria-label="录像回放窗口"
          >
            <StreamPlayer {...props} />
          </section>
        )}
      />
    </div>
  )
}

export function StreamPlayer({
  ref,
  ...props
}: StreamSource & PlaybackOptions & { ref?: Ref<StreamPlayerHandle> }) {
  const {
    track,
    live,
    session,
    loading,
    error,
    expired,
    playbackStatus,
    start,
    finishPlayback,
    onError,
    prepare,
    close,
  } = useStreamSession(props)
  const frame = useRef<HTMLDivElement>(null)
  const controlsHidden = useFullscreenControls(frame)
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null)
  const [startedSessionId, setStartedSessionId] = useState<string>()
  const onLiveStarted = useCallback((id: string) => setStartedSessionId(id), [])
  useImperativeHandle(ref, () => ({ start }))
  const stopLabel = loading ? "取消准备" : live ? "停止预览" : "关闭回放"
  const actions = (
    <>
      {live && session && !error && !expired && (
        <RestartAction
          container={frame}
          label="重新连接"
          onRestart={() => void prepare()}
        />
      )}
      {(loading || session) && (
        <Button
          size="sm"
          variant="outline"
          className="@max-[400px]:w-7 @max-[400px]:gap-0 @max-[400px]:px-0"
          aria-label={stopLabel}
          title={stopLabel}
          onClick={() => {
            close(true)
            props.onStop?.()
          }}
        >
          <XIcon data-icon="inline-start" />
          <span className="@max-[400px]:hidden">{stopLabel}</span>
        </Button>
      )}
    </>
  )
  return (
    <section
      className={cn(
        "stream-player @container flex min-w-0 flex-col gap-0",
        live && "relative aspect-video flex-none"
      )}
      aria-label={live ? "实时播放器" : "录像预览"}
      data-live={live}
      data-state={
        error || expired
          ? "error"
          : loading
            ? "loading"
            : session
              ? "playing"
              : "idle"
      }
    >
      <div
        className={cn(
          "video-surface group/video [container-type:inline-size] relative min-w-0 fullscreen:flex fullscreen:flex-col fullscreen:justify-center fullscreen:bg-black",
          live && "size-full"
        )}
        ref={frame}
        data-live-starting={
          live && !!session && startedSessionId !== session.id
        }
      >
        <SaveFullscreenActivity />
        {session && live && track && <LiveRecordingIndicator track={track} />}
        {session ? (
          <HlsVideo
            key={session.id}
            session={session}
            playbackStatus={playbackStatus}
            live={live}
            liveStarted={startedSessionId === session.id}
            liveTrack={live ? track : undefined}
            requestedTime={props.requestedTime}
            onPlaybackTimeChange={props.onPlaybackTimeChange}
            onStepBoundary={props.onStepBoundary}
            onLiveStarted={onLiveStarted}
            controlsHost={controlsHost}
            onError={onError}
            actions={actions}
            frame={frame}
            clipSource={
              props.live
                ? undefined
                : {
                    track: props.track,
                    date: props.date,
                    segmentId: props.segmentId,
                    channelName: props.channelName ?? `通道 ${props.track}`,
                    timeZone: props.timeZone,
                  }
            }
            initialPreferences={props.initialPreferences}
            onPreferencesChange={props.onPreferencesChange}
            onEnded={() => void finishPlayback()}
          />
        ) : (
          <StreamIdle
            track={track}
            live={live}
            loading={loading}
            error={error}
            expired={expired}
            prepare={prepare}
          />
        )}
        <div
          inert={controlsHidden}
          className={cn(
            "fullscreen-controls contents video-fullscreen:absolute video-fullscreen:inset-x-0 video-fullscreen:bottom-0 video-fullscreen:z-10 video-fullscreen:block video-fullscreen:transition-opacity video-fullscreen:duration-200 motion-reduce:video-fullscreen:transition-none",
            controlsHidden &&
              "video-fullscreen:pointer-events-none video-fullscreen:opacity-0"
          )}
        >
          {props.timeline}
          <div ref={setControlsHost} className="contents" />
          {!session && loading && (
            <div
              className={cn(
                "preview-control-row flex min-w-0 items-center justify-between gap-2 px-2.5 py-2 video-fullscreen:static video-fullscreen:bg-card video-fullscreen:px-4 video-fullscreen:py-2",
                live &&
                  "absolute inset-x-0 bottom-0 bg-card/94 px-1.5 py-1.5 backdrop-blur-md"
              )}
            >
              <div className="preview-actions ml-auto flex shrink-0 items-center gap-1.5">
                {actions}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
