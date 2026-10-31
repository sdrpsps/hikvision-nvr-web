"use client"

import { XIcon } from "lucide-react"
import { useBrowserSaves } from "./context"
import {
  active,
  taskStateLabel,
  formatBytes,
  taskDetailMessage,
} from "@/lib/browser-save/task-display"
import { mediaClock, type SaveTask } from "@/lib/browser-save/types"
import { recordingRange } from "@/lib/browser-save/recording-time"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SquareIcon } from "lucide-react"

export function SaveTaskItem({ task }: { task: SaveTask }) {
  const { stop, dismiss } = useBrowserSaves()
  const message = taskDetailMessage(task)
  const rangeChanged =
    task.source.mode === "history" &&
    task.actualStartSeconds !== undefined &&
    (Math.abs(task.actualStartSeconds - task.source.startSeconds) > 0.001 ||
      (task.actualEndSeconds !== undefined &&
        Math.abs(task.actualEndSeconds - task.source.endSeconds) > 0.001))
  return (
    <li
      key={task.id}
      className="save-task-item flex flex-col gap-2 border-t py-4 [&>[data-slot=button]]:mt-1 [&>[data-slot=button]]:self-start"
      data-state={task.state}
      data-mode={task.source.mode}
    >
      <div className="save-task-heading flex items-center gap-2 [&>strong]:min-w-0 [&>strong]:flex-1 [&>strong]:font-semibold">
        <strong className="truncate">{task.source.channelName}</strong>
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
      <p className="save-task-metrics flex flex-wrap gap-x-4 gap-y-1.5 text-sm tabular-nums">
        {task.source.mode === "history" && active(task) && task.bytes === 0 ? (
          <span>已读取 {formatBytes(task.sourceBytes)}</span>
        ) : (
          <>
            <span>{mediaClock(task.durationSeconds)}</span>
            <span>{formatBytes(task.bytes)}</span>
            {task.files > 1 ? <span>{task.files} 个分段</span> : null}
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
          {task.source.fileStartAt ? "录像选区 " : "文件内选区 "}
          {recordingRange(
            task.source,
            task.source.startSeconds,
            task.source.endSeconds
          ) ??
            `${mediaClock(task.source.startSeconds)} — ${mediaClock(task.source.endSeconds)}`}
          ，原速
        </p>
      )}
      {rangeChanged && task.actualStartSeconds !== undefined && (
        <p className="text-xs text-muted-foreground">
          实际覆盖{" "}
          {task.source.mode === "history" && task.source.fileStartAt
            ? recordingRange(
                task.source,
                task.actualStartSeconds,
                task.actualEndSeconds ?? task.actualStartSeconds
              )
            : `${mediaClock(task.actualStartSeconds)} — ${mediaClock(task.actualEndSeconds ?? task.actualStartSeconds)}`}
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
          {task.state === "stopping" ? "正在收尾并保存" : "停止并保存"}
        </Button>
      )}
    </li>
  )
}
