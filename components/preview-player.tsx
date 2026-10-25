"use client"

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState,
  type Ref,
  type RefObject,
  type ReactNode,
} from "react"
import {
  EllipsisIcon,
  LoaderCircleIcon,
  PlayIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import type { Preview, LiveStream } from "@/shared/contracts"
import type { PlaybackTimeRequest } from "@/lib/playback-clock"
import { HlsVideo, type PlaybackPreferences } from "@/components/hls-video"
import { VideoWall } from "@/components/video-wall"
import { useFullscreenContainer } from "@/hooks/use-fullscreen-container"
import {
  useCreateLiveStream,
  useCreatePlaybackStream,
  useDeleteStream,
  usePlaybackStatus,
} from "@/hooks/use-stream-api"
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
  onActivityChange?: (active: boolean) => void
  requestedTime?: PlaybackTimeRequest
  onPlaybackTimeChange?: (at: string | undefined) => void
  timeline?: ReactNode
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
  const failed = useRef(false)
  const feedbackId = useId()
  const ending = useRef<AbortController | null>(null)
  const releasingPlayback = useRef<{
    id: string
    restartRevision?: number
  } | null>(null)
  const lastStartRequest = useRef<number | undefined>(undefined)
  const automaticallyStarted = useRef(false)
  const frame = useRef<HTMLDivElement>(null)
  const callbacks = useRef(props)
  useEffect(() => {
    callbacks.current = props
  })
  const [session, setSession] = useState<Preview | LiveStream>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [expired, setExpired] = useState(false)
  const notifyError = useCallback(
    (message: string) => {
      toast.error(message, {
        id: `preview-${feedbackId}`,
        description: `${callbacks.current.channelName ?? `通道 ${track}`} · ${live ? "实时预览" : "录像回放"}`,
      })
    },
    [feedbackId, track, live]
  )
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
      if (failed.current) return
      failed.current = true
      ending.current?.abort()
      ending.current = null
      const releasingId = releasingPlayback.current?.id
      releasingPlayback.current = null
      setError(message)
      notifyError(message)
      if (activeId.current && activeId.current !== releasingId)
        void release(activeId.current)
      activeId.current = null
      setSession(undefined)
      callbacks.current.onPlaybackTimeChange?.(undefined)
      callbacks.current.onStop?.()
    },
    [release, notifyError]
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
      const releasingId = releasingPlayback.current?.id
      releasingPlayback.current = null
      if (activeId.current && activeId.current !== releasingId)
        void release(activeId.current)
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
          if (releasingPlayback.current?.id !== session.id)
            void release(session.id)
          activeId.current = null
        }
        setSession(undefined)
        callbacks.current.onPlaybackTimeChange?.(undefined)
        callbacks.current.onStop?.()
      },
      Math.max(0, Date.parse(session.expiresAt) - Date.now())
    )
    return () => clearTimeout(timer)
  }, [session, release])
  const close = useCallback(
    (notify = false) => {
      request.current?.abort()
      ending.current?.abort()
      ending.current = null
      const releasingId = releasingPlayback.current?.id
      releasingPlayback.current = null
      request.current = null
      if (activeId.current && activeId.current !== releasingId) {
        void release(activeId.current).then((released) => {
          if (notify && !released) {
            toast.warning(
              "画面已关闭，后台连接未能确认释放，将自动超时回收。",
              {
                id: `preview-${feedbackId}`,
                description: callbacks.current.channelName ?? `通道 ${track}`,
              }
            )
          }
        })
      }
      activeId.current = null
      failed.current = false
      setSession(undefined)
      callbacks.current.onPlaybackTimeChange?.(undefined)
      setLoading(false)
      setExpired(false)
      setError("")
    },
    [release, feedbackId, track]
  )
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
      if (
        !live &&
        callbacks.current.requestedTime &&
        !("fileRange" in session && session.fileRange)
      ) {
        void release(session.id)
        throw new Error(
          "无法确认录像文件的起始时间，暂不能定位到所选时间。请刷新后重试。"
        )
      }
      activeId.current = session.id
      setSession(session)
    } catch (error) {
      if (!controller.signal.aborted) {
        onError(
          error instanceof DOMException && error.name === "TimeoutError"
            ? "准备预览超时，请重试。"
            : error instanceof Error
              ? error.message
              : "预览准备失败，请重试。"
        )
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
    onError,
  ])
  const requestedRevision = props.requestedTime?.revision
  useEffect(() => {
    if (live) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      const requested =
        requestedRevision !== undefined &&
        requestedRevision !== lastStartRequest.current
      const automatic = props.autoStart && !automaticallyStarted.current
      if (!requested && !automatic) return
      if (requested) lastStartRequest.current = requestedRevision
      if (props.autoStart) automaticallyStarted.current = true
      if (requested) {
        ending.current?.abort()
        ending.current = null
        // An in-flight DELETE cannot be undone. Finish releasing that session
        // before reopening the latest target in the same recording.
        if (releasingPlayback.current) {
          releasingPlayback.current.restartRevision = requestedRevision
          setSession(undefined)
          setLoading(true)
          return
        }
      }
      if (!activeId.current && !request.current) void prepare()
    })
    return () => {
      cancelled = true
    }
  }, [props.autoStart, requestedRevision, live, prepare])
  async function finishPlayback() {
    const id = activeId.current
    if (
      live ||
      !id ||
      ending.current ||
      releasingPlayback.current ||
      !callbacks.current.onPlaybackEnded
    )
      return
    const controller = new AbortController()
    ending.current = controller
    try {
      const status = await confirmPlayback(controller.signal)
      if (controller.signal.aborted || activeId.current !== id) return
      if (!status.complete) {
        toast.warning("录像尚未读取完成，请稍后继续播放。", {
          id: `preview-${feedbackId}`,
          description: callbacks.current.channelName ?? `通道 ${track}`,
        })
        return
      }
      if (!callbacks.current.onPlaybackEnded) return
      const handoff: { id: string; restartRevision?: number } = { id }
      releasingPlayback.current = handoff
      const released = await release(id)
      if (releasingPlayback.current !== handoff) return
      releasingPlayback.current = null
      if (
        handoff.restartRevision !== undefined &&
        handoff.restartRevision === callbacks.current.requestedTime?.revision &&
        activeId.current === id
      ) {
        if (!released) {
          setLoading(false)
          onError("无法关闭上一段录像，请重试。")
          return
        }
        activeId.current = null
        void prepare()
        return
      }
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
  const restartLabel = live ? "重新连接" : "从所选起点播放"
  const startLabel = error || expired ? "重试" : live ? "开始预览" : "播放"
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
        <Empty className="stream-idle" aria-busy={loading}>
          {!loading && (
            <Button
              className="playback-center-button"
              size="icon-lg"
              disabled={!track}
              aria-label={startLabel}
              title={startLabel}
              onClick={() => void prepare()}
            >
              {error || expired ? <RefreshCwIcon /> : <PlayIcon />}
            </Button>
          )}
          {(loading || error || expired) && (
            <EmptyHeader>
              {loading && (
                <LoaderCircleIcon
                  className="player-loading-icon animate-spin"
                  aria-hidden="true"
                />
              )}
              <EmptyTitle role={loading ? "status" : undefined}>
                {loading
                  ? live
                    ? "正在连接通道"
                    : "正在准备录像"
                  : "预览未完成"}
              </EmptyTitle>
              {expired && (
                <EmptyDescription>本次连接已到期，请重试。</EmptyDescription>
              )}
              {error && (
                <EmptyDescription role="alert">{error}</EmptyDescription>
              )}
            </EmptyHeader>
          )}
        </Empty>
      )}
      {!session && props.timeline}
      {!session && loading && (
        <div className="preview-control-row">{actions}</div>
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
