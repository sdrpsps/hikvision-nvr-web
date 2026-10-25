"use client"

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type RefObject,
  type ReactNode,
} from "react"
import { EllipsisIcon, PlayIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import type { Preview, LiveStream } from "@/shared/contracts"
import { HlsVideo, type PlaybackPreferences } from "@/components/hls-video"
import { VideoWall } from "@/components/video-wall"
import { useFullscreenContainer } from "@/hooks/use-fullscreen-container"
import {
  useCreateLiveStream,
  useCreatePlaybackStream,
  useDeleteStream,
  usePlaybackStatus,
} from "@/hooks/use-stream-api"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"

type Source =
  | { track: string; date: string; segmentId: string; live?: false }
  | { track: string; live: true }

export type StreamPlayerHandle = { start: () => void }
type PlaybackOptions = {
  channelName?: string
  timeZone?: string
  autoStart?: boolean
  initialPreferences?: PlaybackPreferences
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
  onPlaybackEnded?: () => void
  onStop?: () => void
  playbackControls?: ReactNode
  onActivityChange?: (active: boolean) => void
}

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
}: Source & PlaybackOptions & { ref?: Ref<StreamPlayerHandle> }) {
  const { track, live = false } = props
  const { mutateAsync: createLive } = useCreateLiveStream()
  const { mutateAsync: createPlayback } = useCreatePlaybackStream()
  const { mutateAsync: release } = useDeleteStream()
  const request = useRef<AbortController | null>(null)
  const activeId = useRef<string | null>(null)
  const ending = useRef<AbortController | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const callbacks = useRef(props)
  useEffect(() => {
    callbacks.current = props
  })
  const [session, setSession] = useState<Preview | LiveStream>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [expired, setExpired] = useState(false)
  const {
    data: playbackStatus,
    error: statusError,
    confirm: confirmPlayback,
  } = usePlaybackStatus(!live && !expired ? session?.id : undefined)
  useEffect(() => {
    callbacks.current.onActivityChange?.(loading || !!session)
  }, [loading, session])
  const onError = useCallback(
    (message: string) => {
      ending.current?.abort()
      ending.current = null
      setError(message)
      if (activeId.current) void release(activeId.current)
      activeId.current = null
      setSession(undefined)
      callbacks.current.onStop?.()
    },
    [release]
  )
  useEffect(() => {
    if (!statusError) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) onError(statusError.message)
    })
    return () => {
      cancelled = true
    }
  }, [statusError, onError])
  useEffect(() => {
    const cleanup = () => {
      request.current?.abort()
      ending.current?.abort()
      if (activeId.current) void release(activeId.current)
      activeId.current = null
    }
    window.addEventListener("pagehide", cleanup)
    return () => {
      window.removeEventListener("pagehide", cleanup)
      cleanup()
      callbacks.current.onActivityChange?.(false)
    }
  }, [release])
  useEffect(() => {
    if (!session) return
    const timer = setTimeout(
      () => {
        setExpired(true)
        if (activeId.current === session.id) {
          void release(session.id)
          activeId.current = null
        }
        if (live) setSession(undefined)
      },
      Math.max(0, Date.parse(session.expiresAt) - Date.now())
    )
    return () => clearTimeout(timer)
  }, [session, live, release])
  const close = useCallback(() => {
    request.current?.abort()
    ending.current?.abort()
    ending.current = null
    request.current = null
    if (activeId.current) void release(activeId.current)
    activeId.current = null
    setSession(undefined)
    setLoading(false)
    setExpired(false)
    setError("")
  }, [release])
  const sourceDate = props.live ? undefined : props.date
  const sourceSegment = props.live ? undefined : props.segmentId
  const prepare = useCallback(async () => {
    close()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const session = live
        ? await createLive({ track, signal: controller.signal })
        : await createPlayback({
            track,
            date: sourceDate!,
            segmentId: sourceSegment!,
            signal: controller.signal,
          })
      if (controller.signal.aborted) {
        void release(session.id)
        return
      }
      activeId.current = session.id
      setSession(session)
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(
          error instanceof DOMException && error.name === "TimeoutError"
            ? "准备预览超时，请重试。"
            : error instanceof Error
              ? error.message
              : "预览准备失败，请重试。"
        )
        callbacks.current.onStop?.()
      }
    } finally {
      if (request.current === controller) {
        request.current = null
        setLoading(false)
      }
    }
  }, [
    close,
    createLive,
    createPlayback,
    release,
    live,
    track,
    sourceDate,
    sourceSegment,
  ])
  useEffect(() => {
    if (!props.autoStart || live) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void prepare()
    })
    return () => {
      cancelled = true
    }
  }, [props.autoStart, live, prepare])
  async function finishPlayback() {
    const id = activeId.current
    if (live || !id || ending.current || !callbacks.current.onPlaybackEnded)
      return
    const controller = new AbortController()
    ending.current = controller
    try {
      const status = await confirmPlayback(controller.signal)
      if (controller.signal.aborted || activeId.current !== id) return
      if (!status.complete) {
        setError("录像尚未读取完成，请稍后继续播放。")
        return
      }
      if (!callbacks.current.onPlaybackEnded) return
      const released = await release(id)
      if (controller.signal.aborted || activeId.current !== id) return
      if (!released) throw new Error("无法关闭上一段录像，请重试。")
      activeId.current = null
      setSession(undefined)
      callbacks.current.onPlaybackEnded?.()
    } catch (error) {
      if (!controller.signal.aborted)
        onError(
          error instanceof Error ? error.message : "回放连接中断，请重试。"
        )
    } finally {
      if (ending.current === controller) ending.current = null
    }
  }
  useImperativeHandle(ref, () => ({
    start() {
      if (track && !activeId.current && !request.current) void prepare()
    },
  }))
  const restartLabel = live ? "重新连接" : "从头播放"
  const startLabel = error || expired ? "重试" : live ? "开始预览" : "播放"
  const stopLabel = loading ? "取消准备" : live ? "停止预览" : "关闭回放"
  const actions = (
    <div className="preview-actions">
      {!loading && (!session || error || expired) && (
        <Button
          size="sm"
          disabled={!track}
          aria-label={startLabel}
          title={startLabel}
          onClick={() => void prepare()}
        >
          {error || expired ? (
            <RefreshCwIcon data-icon="inline-start" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          <span className="control-label">{startLabel}</span>
        </Button>
      )}
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
            close()
            props.onStop?.()
          }}
        >
          <XIcon data-icon="inline-start" />
          <span className="control-label">{stopLabel}</span>
        </Button>
      )}
    </div>
  )
  const errorAlert = error && (
    <Alert variant="destructive">
      <AlertTitle>预览未完成</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
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
      {live && error ? (
        <ScrollArea
          className="live-error-scroll"
          viewportProps={{ className: "live-error-viewport" }}
        >
          {errorAlert}
        </ScrollArea>
      ) : (
        errorAlert
      )}
      {session ? (
        <HlsVideo
          key={session.id}
          session={session}
          playbackStatus={playbackStatus}
          live={live}
          liveTrack={live ? track : undefined}
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
          playbackControls={props.playbackControls}
          initialPreferences={props.initialPreferences}
          onPreferencesChange={props.onPreferencesChange}
          onEnded={() => void finishPlayback()}
        />
      ) : (
        <Empty className="stream-idle">
          <EmptyHeader>
            <EmptyTitle role={loading ? "status" : undefined}>
              {loading
                ? live
                  ? "正在连接通道"
                  : "正在准备录像"
                : "画面未开启"}
            </EmptyTitle>
            {expired && (
              <EmptyDescription>本次连接已到期，请重试。</EmptyDescription>
            )}
          </EmptyHeader>
        </Empty>
      )}
      {!session && (
        <div className="preview-control-row">
          {props.playbackControls}
          {actions}
        </div>
      )}
    </section>
  )
}

function RestartAction({
  container,
  label,
  onRestart,
}: {
  container?: RefObject<HTMLDivElement | null>
  label: string
  onRestart: () => void
}) {
  const [open, setOpen] = useState(false)
  const portalContainer = useFullscreenContainer(container)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="更多播放操作"
            title="更多播放操作"
          />
        }
      >
        <EllipsisIcon />
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        side="top"
        align="end"
        className="w-40"
      >
        <PopoverTitle className="sr-only">播放操作</PopoverTitle>
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            setOpen(false)
            onRestart()
          }}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {label}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
