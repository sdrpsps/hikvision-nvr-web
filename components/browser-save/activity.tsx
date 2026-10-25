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
