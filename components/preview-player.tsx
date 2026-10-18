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
import { Badge } from "@/components/ui/badge"
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
  type Preview,
  type LiveStream,
} from "@/shared/contracts"
import { HlsVideo } from "@/components/hls-video"
import { VideoWall } from "@/components/video-wall"

function release(id: string) {
  void fetch(`/api/streams/${id}`, { method: "DELETE", keepalive: true }).catch(
    () => {}
  )
}
type Source =
  | { track: string; date: string; segmentId: string; live?: false }
  | { track: string; live: true }

export type StreamPlayerHandle = { start: () => void }

export function PreviewPlayer(props: {
  track: string
  date: string
  segmentId: string
}) {
  return (
    <VideoWall
      count={1}
      label="录像预览窗口"
      renderWindow={() => <StreamPlayer {...props} />}
    />
  )
}

export function StreamPlayer({
  ref,
  ...props
}: Source & { ref?: Ref<StreamPlayerHandle> }) {
  const { track, live = false } = props
  const request = useRef<AbortController | null>(null)
  const activeId = useRef<string | null>(null)
  const [session, setSession] = useState<Preview | LiveStream>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [ready, setReady] = useState(false)
  const [expired, setExpired] = useState(false)
  const onError = useCallback((message: string) => {
    setError(message)
    if (activeId.current) release(activeId.current)
    activeId.current = null
  }, [])
  useEffect(() => {
    const cleanup = () => {
      request.current?.abort()
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
  function close() {
    request.current?.abort()
    request.current = null
    if (activeId.current) release(activeId.current)
    activeId.current = null
    setSession(undefined)
    setLoading(false)
    setReady(false)
    setExpired(false)
    setError("")
  }
  async function prepare() {
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
            props.live
              ? { track }
              : { track, date: props.date, segmentId: props.segmentId }
          ),
          signal: controller.signal,
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
      if (!controller.signal.aborted)
        setError(
          error instanceof Error ? error.message : "预览准备失败，请重试。"
        )
    } finally {
      if (request.current === controller) {
        request.current = null
        setLoading(false)
      }
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
      : "重新打开预览"
    : live
      ? "开始预览"
      : "播放文件开头"
  const stopLabel = loading ? "取消准备" : live ? "停止预览" : "关闭预览"
  const actions = (
    <div className="preview-actions">
      {!loading && (
        <Button
          size={live ? "sm" : "default"}
          disabled={!track}
          aria-label={startLabel}
          title={startLabel}
          onClick={() => void prepare()}
        >
          {live && session ? (
            <RefreshCwIcon data-icon="inline-start" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          <span className={live ? "control-label" : undefined}>
            {startLabel}
          </span>
        </Button>
      )}
      {(loading || session) && (
        <Button
          size={live ? "sm" : "default"}
          variant="outline"
          aria-label={stopLabel}
          title={stopLabel}
          onClick={close}
        >
          <XIcon data-icon="inline-start" />
          <span className={live ? "control-label" : undefined}>
            {stopLabel}
          </span>
        </Button>
      )}
    </div>
  )
  return (
    <section
      className={live ? "stream-player" : "preview-panel"}
      aria-label={live ? "实时播放器" : "录像预览"}
    >
      {!live && (
        <>
          <div className="preview-toolbar">
            <div>
              <h3>片段预览</h3>
              <p>
                播放录像文件开头最多 30 秒，可在预览内暂停和跳转。暂不提供音频。
              </p>
            </div>
            <Badge variant="secondary">本机解码</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            文件起点与时间轴时刻的对应关系仍待核对。
          </p>
        </>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>预览未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {session ? (
        <>
          <HlsVideo
            session={session}
            live={live}
            onReady={() => setReady(true)}
            onError={onError}
            actions={live ? actions : undefined}
          />
          {!live && (
            <p className="text-sm text-muted-foreground">
              实际编码：
              {session.codec === "hevc" ? "H.265 / HEVC" : "H.264 / AVC"}
              ，由本机浏览器解码。
            </p>
          )}
          {!live && (
            <p role="status" className="text-sm text-muted-foreground">
              {expired
                ? "会话已到期，已缓冲内容可继续播放；重新打开可再次加载。"
                : ready
                  ? `预览已就绪 · ${"durationSeconds" in session ? Math.round(session.durationSeconds) : 0} 秒，请点击视频播放`
                  : "正在加载本机播放器…"}
            </p>
          )}
        </>
      ) : (
        live && (
          <Empty className="stream-idle">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <VideoIcon />
              </EmptyMedia>
              <EmptyTitle>{loading ? "正在连接通道" : "画面未开启"}</EmptyTitle>
              <EmptyDescription>
                {expired
                  ? "本次会话已到期，请重新开始预览。"
                  : "选择通道后，手动开始预览"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      )}
      {(!live || !session) && (
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
