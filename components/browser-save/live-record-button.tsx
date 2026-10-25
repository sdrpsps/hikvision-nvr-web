"use client"

import { useState } from "react"
import { CircleDotIcon } from "lucide-react"
import { saveCapability } from "@/lib/browser-save/destination"
import { SaveCapabilityNotice } from "./capability-notice"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useBrowserSaves } from "./context"
import { active, taskStateLabel } from "@/lib/browser-save/task-display"
import { mediaClock } from "@/lib/browser-save/types"
import { Button } from "@/components/ui/button"
import { CircleIcon, LoaderCircleIcon, SquareIcon } from "lucide-react"

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
