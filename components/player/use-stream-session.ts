"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"
import type { Preview, LiveStream } from "@/shared/contracts"
import {
  useCreateLiveStream,
  useCreatePlaybackStream,
  useDeleteStream,
  usePlaybackStatus,
} from "@/hooks/use-stream-api"
import type { StreamSource, PlaybackOptions } from "./types"

// Creation, expiry, cancellation and playback handoff share the same session.
// Keep their controllers private so they cannot be released or restarted apart.
export function useStreamSession(props: StreamSource & PlaybackOptions) {
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
  function start() {
    if (track && !activeId.current && !request.current) void prepare()
  }

  return {
    track,
    live,
    session,
    loading,
    error,
    expired,
    playbackStatus,
    onError,
    start,
    close,
    prepare,
    finishPlayback,
  }
}
