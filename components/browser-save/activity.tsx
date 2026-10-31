"use client"

import { useBrowserSaves } from "./context"
import {
  active,
  taskStateLabel,
  formatBytes,
} from "@/lib/browser-save/task-display"
import { mediaClock, type SaveTask } from "@/lib/browser-save/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  CircleIcon,
  DownloadIcon,
  FolderDownIcon,
  LoaderCircleIcon,
  SquareIcon,
} from "lucide-react"

function TaskActivityIcon({ task }: { task: SaveTask }) {
  return task.state === "preparing" || task.state === "stopping" ? (
    <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
  ) : task.source.mode === "live" ? (
    <CircleIcon aria-hidden="true" className="fill-current" />
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
      className="save-tasks-trigger h-9 shrink-0 gap-2 px-3.5 py-2 text-[0.8125rem] font-normal text-muted-foreground hover:bg-secondary hover:text-secondary-foreground aria-[expanded=true]:bg-secondary aria-[expanded=true]:font-semibold aria-[expanded=true]:text-secondary-foreground max-md:flex-1"
      onClick={showTasks}
    >
      <FolderDownIcon data-icon="inline-start" />
      <span className="max-[540px]:text-xs">录制与下载</span>
      {running.length > 0 && (
        <Badge variant="secondary">{running.length}</Badge>
      )}
      {trouble && (
        <span
          className="inline-flex size-4 items-center justify-center rounded-full bg-destructive text-[0.7rem] text-primary-foreground"
          aria-label="有任务需要查看"
        >
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
    <div className="save-activity-bar sticky top-0 z-20 shrink-0 border-b bg-card shadow-[0_2px_6px_color-mix(in_srgb,var(--foreground)_5%,transparent)]">
      <section
        className="save-activity mx-auto max-w-[100rem] px-6 py-2 max-md:px-3"
        aria-label="进行中的录制与下载"
      >
        <ul className="save-activity-list m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,30rem),1fr))] gap-2 p-0">
          {running.map((task) => (
            <li
              key={task.id}
              className="save-activity-item group/task grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border border-l-[3px] border-l-primary bg-secondary px-2.5 py-2 text-[0.8125rem] data-[mode=live]:border-l-destructive data-[mode=live]:bg-[color-mix(in_srgb,var(--destructive)_5%,var(--card))] max-[540px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[540px]:gap-x-2.5 max-[540px]:gap-y-1.5"
              data-mode={task.source.mode}
              data-state={task.state}
            >
              <span className="save-activity-state inline-flex items-center gap-1.5 font-semibold whitespace-nowrap text-primary group-data-[mode=live]/task:text-destructive [&>svg]:size-3.5 [&>svg]:shrink-0">
                <TaskActivityIcon task={task} />
                <span role="status">{taskStateLabel(task)}</span>
              </span>
              <strong
                className="save-activity-channel overflow-hidden font-semibold text-ellipsis whitespace-nowrap max-[540px]:col-span-2 max-[540px]:col-start-2"
                title={task.source.channelName}
              >
                {task.source.channelName}
              </strong>
              <span className="save-activity-progress flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-xs tabular-nums max-[540px]:col-span-2 [&>span]:text-muted-foreground">
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
                className="max-[540px]:col-start-3"
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
      className="save-fullscreen-activity hidden video-fullscreen:absolute video-fullscreen:top-4 video-fullscreen:left-4 video-fullscreen:z-[1] video-fullscreen:inline-flex video-fullscreen:max-w-[calc(100%-2rem)]"
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
    <Badge
      className="live-recording-indicator pointer-events-none absolute top-2.5 right-2.5 z-[1] tabular-nums video-fullscreen:top-14 video-fullscreen:right-4"
      variant="recording"
    >
      <TaskActivityIcon task={task} />
      <span>{taskStateLabel(task)}</span>
      <span>{mediaClock(task.durationSeconds)}</span>
    </Badge>
  )
}
