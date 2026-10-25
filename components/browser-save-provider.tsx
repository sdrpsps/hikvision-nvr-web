"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  CircleIcon,
  CircleDotIcon,
  DownloadIcon,
  FolderDownIcon,
  LoaderCircleIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  chooseDestination,
  releaseDestination,
  saveCapability,
} from "@/lib/browser-save/destination"
import {
  mediaClock,
  safeFilename,
  type SaveSource,
  type SaveTask,
  type SaveWorkerEvent,
  type SaveWorkerRequest,
} from "@/lib/browser-save/types"

const active = (task: SaveTask) =>
  ["preparing", "saving", "stopping"].includes(task.state)
const routineTaskMessages = new Set([
  "请选择保存位置。",
  "正在启动浏览器下载…",
  "正在连接媒体源…",
  "正在收尾并保存文件…",
  "正在补齐停止前画面的声音并保存…",
  "已保存到本机硬盘。",
  "已停止并保存已接收的录像。",
])

function taskDetailMessage(task: SaveTask) {
  if (task.state === "failed" || task.state === "partial") return task.message
  return task.message && !routineTaskMessages.has(task.message)
    ? task.message
    : undefined
}
const context = createContext<{
  tasks: SaveTask[]
  tasksOpen: boolean
  start(source: SaveSource): Promise<void>
  stop(id: string): void
  dismiss(id: string): void
  showTasks(): void
}>({
  tasks: [],
  tasksOpen: false,
  start: async () => {},
  stop: () => {},
  dismiss: () => {},
  showTasks: () => {},
})

export function BrowserSaveProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<SaveTask[]>([])
  const [tasksOpen, setTasksOpen] = useState(false)
  const tasksRef = useRef(tasks)
  const workers = useRef(new Map<string, Worker>())
  const watchdogs = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const notify = useCallback(
    (
      kind: "success" | "warning" | "error" | "info",
      message: string,
      task?: SaveTask
    ) => {
      toast[kind](
        task ? `${task.source.channelName} · ${taskStateLabel(task)}` : message,
        {
          id: task ? `save-${task.id}` : "save-start-notice",
          description:
            task &&
            (kind === "error" ||
              kind === "warning" ||
              !routineTaskMessages.has(message))
              ? message
              : undefined,
          duration: kind === "error" || kind === "warning" ? 12000 : 7000,
          action: {
            label: "查看任务",
            onClick: () => setTasksOpen(true),
          },
        }
      )
    },
    []
  )
  const update = useCallback((fn: (old: SaveTask[]) => SaveTask[]) => {
    const next = fn(tasksRef.current)
    tasksRef.current = next
    setTasks(next)
  }, [])
  const clearWatchdog = useCallback((id: string) => {
    clearTimeout(watchdogs.current.get(id))
    watchdogs.current.delete(id)
  }, [])
  const failWorker = useCallback(
    (id: string, message: string) => {
      clearWatchdog(id)
      workers.current.get(id)?.terminate()
      workers.current.delete(id)
      releaseDestination(id)
      update((old) =>
        old.map((task) =>
          task.id === id ? { ...task, state: "failed", message } : task
        )
      )
      notify(
        "error",
        message,
        tasksRef.current.find((task) => task.id === id)
      )
    },
    [clearWatchdog, notify, update]
  )
  const stop = useCallback(
    (id: string) => {
      if (!workers.current.has(id)) {
        releaseDestination(id)
        update((old) =>
          old.map((task) =>
            task.id === id
              ? {
                  ...task,
                  state: "cancelled",
                  message: "已取消，未开始读取媒体。",
                }
              : task
          )
        )
        return
      }
      workers.current
        .get(id)
        ?.postMessage({ type: "stop" } satisfies SaveWorkerRequest)
      clearWatchdog(id)
      watchdogs.current.set(
        id,
        setTimeout(
          () =>
            failWorker(
              id,
              "保存收尾超时，已停止媒体连接；请检查已保存文件，当前未完成文件可能未保存。"
            ),
          60000
        )
      )
      update((old) =>
        old.map((task) =>
          task.id === id
            ? { ...task, state: "stopping", message: "正在收尾并保存文件…" }
            : task
        )
      )
    },
    [clearWatchdog, failWorker, update]
  )
  const start = useCallback(
    async (source: SaveSource) => {
      const capability = saveCapability()
      if (capability === "insecure" || capability === "unsupported") {
        notify(
          "error",
          capability === "insecure"
            ? "直接写盘需要 HTTPS；本机调试请使用 localhost 地址。"
            : "当前浏览器不支持流式保存，请使用最新版 Chrome 或 Edge。"
        )
        return
      }
      if (tasksRef.current.filter(active).length >= 4) {
        notify("warning", "最多同时保存 4 个任务，请先停止其他任务。")
        return
      }
      if (
        source.mode === "live" &&
        tasksRef.current.some(
          (task) =>
            active(task) &&
            task.source.mode === "live" &&
            task.source.track === source.track
        )
      ) {
        notify("info", `${source.channelName} 已在录制，请在任务面板中查看。`)
        return
      }
      const id = crypto.randomUUID()
      const stamp = new Intl.DateTimeFormat("sv-SE", {
        timeZone: source.timeZone ?? "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .format(new Date())
        .replace(" ", "_")
        .replaceAll(":", "-")
      const range =
        source.mode === "history"
          ? `_${source.date}_文件内${mediaClock(source.startSeconds).replaceAll(":", "-")}-${mediaClock(source.endSeconds).replaceAll(":", "-")}`
          : `_${stamp}`
      const filename = `${safeFilename(source.channelName)}_${source.mode === "live" ? "手动录制" : "录像片段"}${range}_${id.slice(0, 6)}.mkv`
      update((old) => [
        ...old.filter(
          (task) => active(task) || old.indexOf(task) >= old.length - 19
        ),
        {
          id,
          source,
          filename,
          state: "preparing",
          bytes: 0,
          sourceBytes: 0,
          durationSeconds: 0,
          audioPackets: 0,
          files: 0,
          createdAt: Date.now(),
          message:
            capability === "download"
              ? "正在启动浏览器下载…"
              : "请选择保存位置。",
        },
      ])
      try {
        // Called in the click handler before any network await, preserving the
        // transient user activation required by the browser's file picker.
        const destination = await chooseDestination(
          id,
          filename,
          source.mode === "live"
        )
        if (
          tasksRef.current.find((task) => task.id === id)?.state === "cancelled"
        ) {
          if (destination.type === "download") destination.port.close()
          releaseDestination(id)
          return
        }
        update((old) =>
          old.map((task) =>
            task.id === id ? { ...task, saveMode: destination.type } : task
          )
        )
        const worker = new Worker(
          new URL("../lib/browser-save/runner.worker.ts", import.meta.url),
          { type: "module" }
        )
        workers.current.set(id, worker)
        worker.onmessage = (event: MessageEvent<SaveWorkerEvent>) => {
          if (workers.current.get(id) !== worker) return
          if (event.data.type === "ready") {
            if (
              tasksRef.current.find((task) => task.id === id)?.state !==
              "stopping"
            )
              clearWatchdog(id)
            return
          }
          update((old) =>
            old.map((task) =>
              task.id === id ? { ...task, ...event.data.patch } : task
            )
          )
          if (event.data.type === "done") {
            clearWatchdog(id)
            const task = tasksRef.current.find((task) => task.id === id)
            notify(
              task?.state === "complete"
                ? "success"
                : task?.state === "partial"
                  ? "warning"
                  : task?.state === "failed"
                    ? "error"
                    : "info",
              task?.message ?? "任务已结束。",
              task
            )
            worker.terminate()
            workers.current.delete(id)
            releaseDestination(id)
          }
        }
        worker.onerror = () => {
          failWorker(id, "浏览器媒体处理意外中断，当前未完成文件可能未保存。")
        }
        const request: SaveWorkerRequest = {
          type: "start",
          id,
          source,
          filename,
          destination,
        }
        watchdogs.current.set(
          id,
          setTimeout(
            () =>
              failWorker(
                id,
                "浏览器媒体处理启动超时，请重试；本次保存已停止。"
              ),
            20000
          )
        )
        worker.postMessage(
          request,
          destination.type === "download" ? [destination.port] : []
        )
        update((old) =>
          old.map((task) =>
            task.id === id ? { ...task, message: "正在连接媒体源…" } : task
          )
        )
      } catch (error) {
        clearWatchdog(id)
        workers.current.get(id)?.terminate()
        workers.current.delete(id)
        releaseDestination(id)
        if (
          tasksRef.current.find((task) => task.id === id)?.state === "cancelled"
        )
          return
        if (error instanceof DOMException && error.name === "AbortError") {
          update((old) => old.filter((task) => task.id !== id))
          return
        }
        const message =
          error instanceof Error ? error.message : "无法准备保存位置，请重试。"
        update((old) =>
          old.map((task) =>
            task.id === id ? { ...task, state: "failed", message } : task
          )
        )
        notify(
          "error",
          message,
          tasksRef.current.find((task) => task.id === id)
        )
      }
    },
    [clearWatchdog, failWorker, notify, update]
  )
  useEffect(() => {
    const current = workers.current
    const currentWatchdogs = watchdogs.current
    const warn = (event: BeforeUnloadEvent) => {
      if (!tasksRef.current.some(active)) return
      event.preventDefault()
      event.returnValue = ""
    }
    const pagehide = () => {
      for (const worker of current.values())
        worker.postMessage({ type: "stop" } satisfies SaveWorkerRequest)
    }
    window.addEventListener("beforeunload", warn)
    window.addEventListener("pagehide", pagehide)
    return () => {
      window.removeEventListener("beforeunload", warn)
      window.removeEventListener("pagehide", pagehide)
      for (const worker of current.values()) worker.terminate()
      current.clear()
      for (const timeout of currentWatchdogs.values()) clearTimeout(timeout)
      currentWatchdogs.clear()
    }
  }, [])
  return (
    <context.Provider
      value={{
        tasks,
        tasksOpen,
        start,
        stop,
        showTasks: () => setTasksOpen(true),
        dismiss: (id) =>
          update((old) => old.filter((task) => task.id !== id || active(task))),
      }}
    >
      {children}
      <SaveTasksPanel open={tasksOpen} onOpenChange={setTasksOpen} />
    </context.Provider>
  )
}

export function useBrowserSaves() {
  return useContext(context)
}

function taskStateLabel(task: SaveTask) {
  return {
    preparing:
      task.source.mode === "live"
        ? "准备录制"
        : task.sourceBytes > 0
          ? "读取录像"
          : "准备下载",
    saving: task.source.mode === "live" ? "录制中" : "下载中",
    stopping: "收尾中",
    complete: task.saveMode === "download" ? "传送完成" : "已保存",
    partial: "部分保存",
    failed: "失败",
    cancelled: "已取消",
  }[task.state]
}

function TaskActivityIcon({ task }: { task: SaveTask }) {
  return task.state === "preparing" || task.state === "stopping" ? (
    <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
  ) : task.source.mode === "live" ? (
    <CircleIcon aria-hidden="true" className="save-record-dot" />
  ) : (
    <DownloadIcon aria-hidden="true" />
  )
}

export function SaveTasksButton() {
  const { tasks, tasksOpen, showTasks } = useBrowserSaves()
  const running = tasks.filter(active)
  const trouble = tasks.some(
    (task) => task.state === "failed" || task.state === "partial"
  )
  return (
    <Button
      variant="ghost"
      aria-label="录制与下载任务"
      aria-haspopup="dialog"
      aria-expanded={tasksOpen}
      className="save-tasks-trigger"
      onClick={showTasks}
    >
      <FolderDownIcon data-icon="inline-start" />
      <span className="save-task-label">录制与下载</span>
      {running.length > 0 && (
        <Badge variant="secondary">{running.length}</Badge>
      )}
      {trouble && (
        <span className="save-task-attention" aria-label="有任务需要查看">
          !
        </span>
      )}
    </Button>
  )
}

export function SaveActivityBar() {
  const { tasks, stop } = useBrowserSaves()
  const running = tasks.filter(active)
  if (!running.length) return null
  return (
    <div className="save-activity-bar">
      <section className="save-activity" aria-label="进行中的录制与下载">
        <ul className="save-activity-list">
          {running.map((task) => (
            <li
              key={task.id}
              className="save-activity-item"
              data-mode={task.source.mode}
              data-state={task.state}
            >
              <span className="save-activity-state">
                <TaskActivityIcon task={task} />
                <span role="status">{taskStateLabel(task)}</span>
              </span>
              <strong
                className="save-activity-channel"
                title={task.source.channelName}
              >
                {task.source.channelName}
              </strong>
              <span className="save-activity-progress">
                {task.source.mode === "history" && task.bytes === 0 ? (
                  `已读取 ${formatBytes(task.sourceBytes)}`
                ) : (
                  <>
                    {task.source.mode === "live"
                      ? mediaClock(task.durationSeconds)
                      : `已写入 ${mediaClock(task.durationSeconds)}`}
                    <span>{formatBytes(task.bytes)}</span>
                  </>
                )}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={task.state === "stopping"}
                aria-label={`停止并保存 ${task.source.channelName}`}
                onClick={() => stop(task.id)}
              >
                <SquareIcon data-icon="inline-start" />
                {task.state === "stopping" ? "正在收尾" : "停止并保存"}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

// Fullscreen hides the page header. Keep access to ongoing jobs inside the
// fullscreen surface, and portal the shared task panel into that surface.
export function SaveFullscreenActivity() {
  const { tasks, showTasks } = useBrowserSaves()
  const running = tasks.filter(active)
  const trouble = tasks.some(
    (task) => task.state === "failed" || task.state === "partial"
  )
  if (!tasks.length) return null
  const liveCount = running.filter((task) => task.source.mode === "live").length
  const downloadCount = running.length - liveCount
  return (
    <Button
      className="save-fullscreen-activity"
      aria-haspopup="dialog"
      variant={trouble ? "destructive" : "secondary"}
      size="sm"
      onClick={showTasks}
      title={!running.length ? tasks[tasks.length - 1]?.message : undefined}
    >
      <FolderDownIcon data-icon="inline-start" />
      <span className="truncate">
        {!running.length
          ? trouble
            ? "保存异常"
            : "保存已结束"
          : running.length === 1
            ? `${running[0].source.channelName} · ${taskStateLabel(running[0])}`
            : [
                liveCount ? `录制 ${liveCount} 路` : "",
                downloadCount ? `下载 ${downloadCount} 项` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
        {running.length > 0 && trouble ? " · 有任务异常" : ""}
      </span>
      <span className="shrink-0">
        {running.length ? "查看任务" : "查看结果"}
      </span>
    </Button>
  )
}

export function LiveRecordingIndicator({ track }: { track: string }) {
  const { tasks } = useBrowserSaves()
  const task = tasks.find(
    (task) =>
      active(task) && task.source.mode === "live" && task.source.track === track
  )
  if (!task) return null
  return (
    <Badge className="live-recording-indicator" variant="recording">
      <TaskActivityIcon task={task} />
      <span>{taskStateLabel(task)}</span>
      <span>{mediaClock(task.durationSeconds)}</span>
    </Badge>
  )
}

function SaveTasksPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const { tasks, stop, dismiss } = useBrowserSaves()
  const [fullscreen, setFullscreen] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const update = () =>
      setFullscreen(
        document.fullscreenElement instanceof HTMLElement
          ? document.fullscreenElement
          : null
      )
    update()
    document.addEventListener("fullscreenchange", update)
    return () => document.removeEventListener("fullscreenchange", update)
  }, [])
  const ordered = [...tasks]
    .reverse()
    .sort((a, b) => Number(active(b)) - Number(active(a)))
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        container={fullscreen ?? undefined}
        className="save-tasks-panel"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>录制与下载</SheetTitle>
          <SheetDescription className="sr-only">
            保存进度与结果
          </SheetDescription>
        </SheetHeader>
        <ScrollArea
          className="save-tasks-scroll"
          viewportProps={{ "aria-label": "录制与下载任务列表" }}
        >
          <div className="save-tasks-content">
            {tasks.some(active) && (
              <p className="text-xs text-muted-foreground">
                保存期间请勿关闭或刷新网页，避免电脑休眠。
              </p>
            )}
            {!tasks.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>暂无录制或下载任务</EmptyTitle>
                  <EmptyDescription>
                    在实时窗口开始录制，或在回放中选择片段下载。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            <ul className="save-task-list">
              {ordered.map((task) => {
                const message = taskDetailMessage(task)
                const rangeChanged =
                  task.source.mode === "history" &&
                  task.actualStartSeconds !== undefined &&
                  (Math.abs(
                    task.actualStartSeconds - task.source.startSeconds
                  ) > 0.001 ||
                    (task.actualEndSeconds !== undefined &&
                      Math.abs(task.actualEndSeconds - task.source.endSeconds) >
                        0.001))
                return (
                  <li
                    key={task.id}
                    className="save-task-item"
                    data-state={task.state}
                    data-mode={task.source.mode}
                  >
                    <div className="save-task-heading">
                      <strong className="truncate">
                        {task.source.channelName}
                      </strong>
                      <span className="text-xs text-muted-foreground">
                        {task.source.mode === "live" ? "录制" : "下载"}
                      </span>
                      <Badge
                        variant={
                          task.state === "failed" || task.state === "partial"
                            ? "destructive"
                            : active(task) && task.source.mode === "live"
                              ? "recording"
                              : "secondary"
                        }
                      >
                        {taskStateLabel(task)}
                      </Badge>
                      {!active(task) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`移除任务 ${task.source.channelName}`}
                          onClick={() => dismiss(task.id)}
                        >
                          <XIcon />
                        </Button>
                      )}
                    </div>
                    <p className="save-task-metrics">
                      {task.source.mode === "history" &&
                      active(task) &&
                      task.bytes === 0 ? (
                        <span>已读取 {formatBytes(task.sourceBytes)}</span>
                      ) : (
                        <>
                          <span>{mediaClock(task.durationSeconds)}</span>
                          <span>{formatBytes(task.bytes)}</span>
                          {task.files > 1 ? (
                            <span>{task.files} 个分段</span>
                          ) : null}
                          {task.audioPackets ? <span>含原始声音</span> : null}
                        </>
                      )}
                    </p>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={task.filename}
                    >
                      {task.filename}
                    </p>
                    {active(task) && task.source.mode === "live" && (
                      <p className="text-xs text-muted-foreground">
                        录满 {task.source.limitSeconds / 60} 分钟自动结束
                      </p>
                    )}
                    {task.source.mode === "history" && (
                      <p className="text-xs text-muted-foreground">
                        文件内选区 {mediaClock(task.source.startSeconds)} —{" "}
                        {mediaClock(task.source.endSeconds)}，原速
                      </p>
                    )}
                    {rangeChanged && task.actualStartSeconds !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        实际覆盖 {mediaClock(task.actualStartSeconds)} —{" "}
                        {mediaClock(
                          task.actualEndSeconds ?? task.actualStartSeconds
                        )}
                      </p>
                    )}
                    {message && (
                      <p
                        role={
                          task.state === "failed" || task.state === "partial"
                            ? "alert"
                            : "status"
                        }
                        className="text-xs"
                      >
                        {message}
                      </p>
                    )}
                    {active(task) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={task.state === "stopping"}
                        aria-label={`停止并保存 ${task.source.channelName}`}
                        onClick={() => stop(task.id)}
                      >
                        <SquareIcon data-icon="inline-start" />
                        {task.state === "stopping"
                          ? "正在收尾并保存"
                          : "停止并保存"}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

export function LiveRecordButton({
  track,
  name,
  timeZone,
}: {
  track: string
  name: string
  timeZone?: string
}) {
  const { tasks, start, stop } = useBrowserSaves()
  const task = tasks.find(
    (task) =>
      active(task) && task.source.mode === "live" && task.source.track === track
  )
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(30)
  const [segmented, setSegmented] = useState(false)
  const [nativeDownload, setNativeDownload] = useState(false)
  if (task)
    return (
      <Button
        className="live-record-trigger"
        size="sm"
        variant="destructive"
        aria-label={`停止录制 ${name}`}
        title={`${name} ${taskStateLabel(task)} ${mediaClock(task.durationSeconds)}，点击停止并保存`}
        disabled={task.state === "stopping"}
        onClick={() => stop(task.id)}
      >
        {task.state === "preparing" || task.state === "stopping" ? (
          <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
        ) : (
          <SquareIcon data-icon="inline-start" />
        )}
        <span>{task.state === "stopping" ? "收尾" : "停止"}</span>
      </Button>
    )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setNativeDownload(saveCapability() === "download")
          setSegmented(
            "showDirectoryPicker" in window &&
              typeof window.showDirectoryPicker === "function"
          )
        }
        setOpen(next)
      }}
    >
      <DialogTrigger
        render={
          <Button
            className="live-record-trigger"
            variant="ghost"
            size="sm"
            aria-label={`录制 ${name}`}
            title="手动录制到本机"
            disabled={!track}
          />
        }
      >
        <CircleDotIcon data-icon="inline-start" />
        <span>录制</span>
      </DialogTrigger>
      <DialogContent className="save-setup-dialog">
        <DialogHeader>
          <DialogTitle>录制 {name}</DialogTitle>
          <DialogDescription>切换通道或页面，录制仍会继续。</DialogDescription>
        </DialogHeader>
        <ScrollArea className="save-setup-scroll">
          <div className="save-setup-content">
            <p className="text-sm font-medium">自动结束时间</p>
            <ToggleGroup
              aria-label="录制自动结束时间"
              value={[String(limit)]}
              onValueChange={(values) => {
                if (values[0]) setLimit(Number(values[0]))
              }}
              variant="outline"
              size="sm"
            >
              {[15, 30, 60].map((minutes) => (
                <ToggleGroupItem key={minutes} value={String(minutes)}>
                  {minutes} 分钟
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-sm text-muted-foreground">
              录制期间请勿关闭或刷新网页，避免电脑休眠。
            </p>
            {segmented && (
              <p className="text-xs text-muted-foreground">
                每 5 分钟保存一个文件。
              </p>
            )}
            <SaveCapabilityNotice />
          </div>
        </ScrollArea>
        <div className="save-setup-actions">
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              setOpen(false)
              void start({
                mode: "live",
                track,
                channelName: name,
                limitSeconds: limit * 60,
                timeZone,
              })
            }}
          >
            <CircleIcon data-icon="inline-start" />
            {nativeDownload ? "开始录制" : "选择位置并录制"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function formatBytes(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

export function SaveCapabilityNotice() {
  const [capability, setCapability] = useState("pending")
  useEffect(() => {
    const timeout = setTimeout(() => setCapability(saveCapability()), 0)
    return () => clearTimeout(timeout)
  }, [])
  if (capability === "download")
    return (
      <p className="text-sm text-muted-foreground">
        文件保存到浏览器的下载位置，可在下载列表中查看。
      </p>
    )
  return capability === "insecure" || capability === "unsupported" ? (
    <Alert variant="destructive">
      <AlertTitle>当前环境无法流式保存</AlertTitle>
      <AlertDescription>
        {capability === "insecure"
          ? "请通过 HTTPS 或本机 localhost 打开。"
          : "请使用支持文件直写或流式下载的浏览器。"}
      </AlertDescription>
    </Alert>
  ) : null
}
