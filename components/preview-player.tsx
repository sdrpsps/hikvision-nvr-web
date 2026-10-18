"use client"

import { useEffect, useRef, useState } from "react"
import { PlayIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { errorSchema, previewSchema, type Preview } from "@/shared/contracts"

function release(id: string) {
  void fetch(`/api/streams/${id}`, { method: "DELETE", keepalive: true }).catch(
    () => {}
  )
}
export function PreviewPlayer({
  track,
  date,
  segmentId,
}: {
  track: string
  date: string
  segmentId: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const request = useRef<AbortController | null>(null)
  const activeId = useRef<string | null>(null)
  const [preview, setPreview] = useState<Preview>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [ready, setReady] = useState(false)
  const [expired, setExpired] = useState(false)
  useEffect(
    () => () => {
      request.current?.abort()
      if (activeId.current) release(activeId.current)
    },
    []
  )

  useEffect(() => {
    if (!preview || !video.current) return
    const element = video.current
    let disposed = false
    let hls: import("hls.js").default | undefined
    const expires = setTimeout(
      () => {
        setExpired(true)
        // The browser may retain its already buffered preview after the server TTL.
        if (activeId.current === preview.id) activeId.current = null
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now())
    )
    const onError = () =>
      setError(
        `无法播放 ${preview.codec === "hevc" ? "H.265 / HEVC" : "H.264"} 预览。请检查浏览器是否支持此编码，或重新打开已过期的预览。`
      )
    element.addEventListener("error", onError)
    if (element.canPlayType("application/vnd.apple.mpegurl"))
      element.src = preview.playlistUrl
    else {
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (disposed) return
          if (!Hls.isSupported()) {
            setError("此浏览器不支持 HLS 播放，请使用新版 Safari 或 Chrome。")
            return
          }
          hls = new Hls({
            enableWorker: true,
            maxBufferLength: 35,
            backBufferLength: 35,
          })
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              hls?.destroy()
              setError(
                `预览加载失败。请重新打开，并确认浏览器支持 ${preview.codec === "hevc" ? "H.265 / HEVC" : "H.264"}。`
              )
            }
          })
          hls.loadSource(preview.playlistUrl)
          hls.attachMedia(element)
        })
        .catch(() => {
          if (!disposed) setError("播放器加载失败，请重试。")
        })
    }
    return () => {
      disposed = true
      clearTimeout(expires)
      hls?.destroy()
      element.removeEventListener("error", onError)
      element.pause()
      element.removeAttribute("src")
      element.load()
    }
  }, [preview])

  function close() {
    request.current?.abort()
    request.current = null
    if (activeId.current) release(activeId.current)
    activeId.current = null
    setPreview(undefined)
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
      const response = await fetch("/api/streams/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track, date, segmentId }),
        signal: controller.signal,
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const parsed = errorSchema.safeParse(body)
        throw new Error(
          parsed.success ? parsed.data.error.message : "预览准备失败，请重试。"
        )
      }
      const parsed = previewSchema.safeParse(body)
      if (!parsed.success) throw new Error("预览响应不完整，请重新查询。")
      if (controller.signal.aborted) {
        release(parsed.data.id)
        return
      }
      activeId.current = parsed.data.id
      setPreview(parsed.data)
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
  return (
    <section className="preview-panel" aria-label="录像预览">
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
      {error && (
        <Alert variant="destructive">
          <AlertTitle>预览未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {preview && (
        <>
          <p className="text-sm text-muted-foreground">
            实际编码：
            {preview.codec === "hevc" ? "H.265 / HEVC" : "H.264 / AVC"}
            ，由本机浏览器解码。
          </p>
          <video
            ref={video}
            className="preview-video"
            controls
            playsInline
            preload="auto"
            aria-label="历史录像预览"
            onCanPlay={() => setReady(true)}
          />
          <p role="status" className="text-sm text-muted-foreground">
            {expired
              ? "会话已到期，已缓冲内容可继续播放；重新打开可再次加载。"
              : ready
                ? `预览已就绪 · ${Math.round(preview.durationSeconds)} 秒，请点击视频播放`
                : "正在加载本机播放器…"}
          </p>
        </>
      )}
      {loading && <p role="status">正在准备预览，请稍候…</p>}
      <div className="preview-actions">
        {!loading && (
          <Button onClick={() => void prepare()}>
            <PlayIcon data-icon="inline-start" />
            {preview ? "重新打开预览" : "播放文件开头"}
          </Button>
        )}
        {(loading || preview) && (
          <Button variant="outline" onClick={close}>
            <XIcon data-icon="inline-start" />
            {loading ? "取消准备" : "关闭预览"}
          </Button>
        )}
      </div>
    </section>
  )
}
