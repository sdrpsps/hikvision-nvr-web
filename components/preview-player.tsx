"use client"

import { useImperativeHandle, useRef, type Ref } from "react"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { HlsVideo } from "@/components/hls-video"
import { VideoWall } from "@/components/video-wall"
import type {
  StreamSource,
  PlaybackOptions,
  StreamPlayerHandle,
} from "./player/types"
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
    <div className="playback-player">
      <VideoWall
        count={1}
        label="录像预览窗口"
        renderWindow={() => (
          <section className="live-window" aria-label="录像回放窗口">
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
  useImperativeHandle(ref, () => ({ start }))
  const restartLabel = live ? "重新连接" : "从所选起点播放"
  const stopLabel = loading ? "取消准备" : live ? "停止预览" : "关闭回放"
  const actions = (
    <div className="preview-actions">
      {session && !error && !expired && (
        <RestartAction
          container={frame}
          label={restartLabel}
          onRestart={() => void prepare()}
        />
      )}
      {(loading || session) && (
        <Button
          size="sm"
          variant="outline"
          aria-label={stopLabel}
          title={stopLabel}
          onClick={() => {
            close(true)
            props.onStop?.()
          }}
        >
          <XIcon data-icon="inline-start" />
          <span className="control-label">{stopLabel}</span>
        </Button>
      )}
    </div>
  )
  return (
    <section
      className="stream-player"
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
      {session ? (
        <HlsVideo
          key={session.id}
          session={session}
          playbackStatus={playbackStatus}
          live={live}
          liveTrack={live ? track : undefined}
          requestedTime={props.requestedTime}
          onPlaybackTimeChange={props.onPlaybackTimeChange}
          timeline={props.timeline}
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
      {!session && props.timeline}
      {!session && loading && (
        <div className="preview-control-row">{actions}</div>
      )}
    </section>
  )
}
