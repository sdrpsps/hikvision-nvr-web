"use client"

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react"
import { PlayIcon, RefreshCwIcon, XIcon, VideoIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import {
  errorSchema,
  liveSchema,
  previewSchema,
  playbackStatusSchema,
  type Preview,
  type LiveStream,
} from "@/shared/contracts"
import { HlsVideo, type PlaybackPreferences } from "@/components/hls-video"
import { VideoWall } from "@/components/video-wall"

function release(id: string) {
  return fetch(`/api/streams/${id}`, {
    method: "DELETE",
    keepalive: true,
    signal: AbortSignal.timeout(8000),
  })
    .then((response) => response.ok)
    .catch(() => false)
}
type Source =
  | { track: string; date: string; segmentId: string; live?: false }
  | { track: string; live: true }

export type StreamPlayerHandle = { start: () => void }
type PlaybackOptions = {
  autoStart?: boolean
  initialPreferences?: PlaybackPreferences
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
  onPlaybackEnded?: () => void
  onStop?: () => void
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
            <div className="window-heading">
              <h3>录像回放</h3>
            </div>
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
  const request = useRef<AbortController | null>(null)
  const activeId = useRef<string | null>(null)
  const ending = useRef<AbortController | null>(null)
  const callbacks = useRef(props)
  useEffect(() => {
    callbacks.current = props
  })
  const [session, setSession] = useState<Preview | LiveStream>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [expired, setExpired] = useState(false)
  const onError = useCallback((message: string) => {
    ending.current?.abort()
    ending.current = null
    setError(message)
    if (activeId.current) release(activeId.current)
    activeId.current = null
    setSession(undefined)
    callbacks.current.onStop?.()
  }, [])
  useEffect(() => {
    if (live || !session) return
    const controller = new AbortController()
    let pending = false
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void fetch(`/api/streams/${session.id}/status`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      })
        .then(async (response) => {
          const body: unknown = await response.json()
          if (response.ok && playbackStatusSchema.safeParse(body).success)
            return
          const error = errorSchema.safeParse(body)
          throw new Error(
            error.success
              ? error.data.error.message
              : "回放连接中断，请重新播放。"
          )
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            onError(
              error instanceof Error
                ? error.message
                : "回放连接中断，请重新播放。"
            )
        })
        .finally(() => {
          pending = false
        })
    }, 20_000)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [live, session, onError])
  useEffect(() => {
    const cleanup = () => {
      request.current?.abort()
      ending.current?.abort()
      if (activeId.current) release(activeId.current)
      activeId.current = null
    }
    window.addEventListener("pagehide", cleanup)
    return () => {
      window.removeEventListener("pagehide", cleanup)
      cleanup()
    }
  }, [])
  useEffect(() => {
    if (!session) return
    const timer = setTimeout(
      () => {
        setExpired(true)
        if (activeId.current === session.id) {
          release(session.id)
          activeId.current = null
        }
        if (live) setSession(undefined)
      },
      Math.max(0, Date.parse(session.expiresAt) - Date.now())
    )
    return () => clearTimeout(timer)
  }, [session, live])
  const close = useCallback(() => {
    request.current?.abort()
    ending.current?.abort()
    ending.current = null
    request.current = null
    if (activeId.current) release(activeId.current)
    activeId.current = null
    setSession(undefined)
    setLoading(false)
    setExpired(false)
    setError("")
  }, [])
  const sourceDate = props.live ? undefined : props.date
  const sourceSegment = props.live ? undefined : props.segmentId
  const prepare = useCallback(async () => {
    close()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const response = await fetch(
        live ? "/api/streams/live" : "/api/streams/playback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            live
              ? { track }
              : { track, date: sourceDate, segmentId: sourceSegment }
          ),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(live ? 25_000 : 35_000),
          ]),
        }
      )
      const body: unknown = await response.json()
      if (!response.ok) {
        const parsed = errorSchema.safeParse(body)
        throw new Error(
          parsed.success ? parsed.data.error.message : "预览准备失败，请重试。"
        )
      }
      const parsed = (live ? liveSchema : previewSchema).safeParse(body)
      if (!parsed.success) throw new Error("预览响应不完整，请重新查询。")
      if (controller.signal.aborted) {
        release(parsed.data.id)
        return
      }
      activeId.current = parsed.data.id
      setSession(parsed.data)
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
  }, [close, live, track, sourceDate, sourceSegment])
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
      const response = await fetch(`/api/streams/${id}/status`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      })
      const body: unknown = await response.json()
      if (controller.signal.aborted || activeId.current !== id) return
      const parsed = playbackStatusSchema.safeParse(body)
      if (!response.ok || !parsed.success)
        throw new Error("无法确认录像读取状态，请重新播放。")
      if (!parsed.data.complete) {
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
  const startLabel = session
    ? live
      ? "重新连接"
      : "重新播放"
    : live
      ? "开始预览"
      : "播放"
  const stopLabel = loading ? "取消准备" : live ? "停止预览" : "关闭回放"
  const actions = (
    <div className="preview-actions">
      {!loading && (
        <Button
          size="sm"
          disabled={!track}
          aria-label={startLabel}
          title={startLabel}
          onClick={() => void prepare()}
        >
          {session ? (
            <RefreshCwIcon data-icon="inline-start" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          <span className="control-label">{startLabel}</span>
        </Button>
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
  return (
    <section
      className="stream-player"
      aria-label={live ? "实时播放器" : "录像预览"}
    >
      {error && (
        <Alert variant="destructive">
          <AlertTitle>预览未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {session ? (
        <HlsVideo
          key={session.id}
          session={session}
          live={live}
          onError={onError}
          actions={actions}
          initialPreferences={props.initialPreferences}
          onPreferencesChange={props.onPreferencesChange}
          onEnded={() => void finishPlayback()}
        />
      ) : (
        <Empty className="stream-idle">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <VideoIcon />
            </EmptyMedia>
            <EmptyTitle>
              {loading
                ? live
                  ? "正在连接通道"
                  : "正在准备录像"
                : "画面未开启"}
            </EmptyTitle>
            {live && (
              <EmptyDescription>
                {expired
                  ? "本次会话已到期，请重新开始预览。"
                  : "选择通道后，手动开始预览"}
              </EmptyDescription>
            )}
          </EmptyHeader>
        </Empty>
      )}
      {!session && (
        <div className="preview-control-row">
          {loading && (
            <p role="status" className="truncate" title="正在准备预览，请稍候…">
              正在准备预览，请稍候…
            </p>
          )}
          {actions}
        </div>
      )}
    </section>
  )
}
