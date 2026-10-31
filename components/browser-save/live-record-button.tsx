"use client"

import { useState } from "react"
import { CircleDotIcon, LoaderCircleIcon, SquareIcon } from "lucide-react"
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
        className="live-record-trigger min-w-[3.625rem] shrink-0 px-1.5 @max-[12rem]:min-w-7 @max-[12rem]:px-1"
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
        <span className="@max-[12rem]:hidden">
          {task.state === "stopping" ? "收尾" : "停止"}
        </span>
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
            className="live-record-trigger min-w-[3.625rem] shrink-0 px-1.5 @max-[12rem]:min-w-7 @max-[12rem]:px-1"
            variant="ghost"
            size="sm"
            aria-label={`录制 ${name}`}
            title="手动录制到本机"
            disabled={!track}
          />
        }
      >
        <CircleDotIcon data-icon="inline-start" />
        <span className="@max-[12rem]:hidden">录制</span>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] max-w-none flex-col">
        <DialogHeader className="shrink-0 pr-7">
          <DialogTitle>录制 {name}</DialogTitle>
          <DialogDescription>切换通道或页面，录制仍会继续。</DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex min-h-0 flex-[0_1_auto] flex-col [&>[data-slot=scroll-area-viewport]]:h-auto [&>[data-slot=scroll-area-viewport]]:min-h-0">
          <div className="flex flex-col gap-4 p-1">
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
        <div className="flex shrink-0 justify-end gap-2 border-t pt-3.5">
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
            <CircleDotIcon data-icon="inline-start" />
            {nativeDownload ? "开始录制" : "选择位置并录制"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
