"use client"

import { useState, useEffect } from "react"
import { SaveTaskItem } from "./task-item"
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
import { useBrowserSaves } from "./context"
import { active } from "@/lib/browser-save/task-display"

export function SaveTasksPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const { tasks } = useBrowserSaves()
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
        className="save-tasks-panel max-h-dvh w-[min(28rem,100vw)] max-w-none gap-0 sm:max-w-none"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>录制与下载</SheetTitle>
          <SheetDescription className="sr-only">
            保存进度与结果
          </SheetDescription>
        </SheetHeader>
        <ScrollArea
          className="save-tasks-scroll min-h-0 flex-1"
          viewportProps={{ "aria-label": "录制与下载任务列表" }}
        >
          <div className="save-tasks-content flex flex-col gap-4 px-4 pb-4">
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
            <ul className="save-task-list m-0 flex list-none flex-col gap-3 p-0">
              {ordered.map((task) => (
                <SaveTaskItem key={task.id} task={task} />
              ))}
            </ul>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
