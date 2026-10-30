"use client"

import { useId, useState, type RefObject } from "react"
import { DownloadIcon, FlagIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  useBrowserSaves,
  SaveCapabilityNotice,
} from "@/components/browser-save-provider"
import { useFullscreenContainer } from "@/hooks/use-fullscreen-container"
import { mediaClock } from "@/lib/browser-save/types"
import { useClipSelection } from "@/hooks/use-clip-selection"

export type ClipSource = {
  track: string
  date: string
  segmentId: string
  channelName: string
  timeZone?: string
  fileStartAt?: string
}

export function ClipExport({
  source,
  position,
  duration,
  container,
}: {
  source: ClipSource
  position: number
  duration?: number
  container?: RefObject<HTMLDivElement | null>
}) {
  const { start } = useBrowserSaves()
  const [open, setOpen] = useState(false)
  const { from, to, a, b, valid, max, error, clock, change, mark, selection } =
    useClipSelection(source.fileStartAt, source.timeZone, duration)
  const id = useId()
  const portal = useFullscreenContainer(container)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="player-control-button"
            aria-label="下载片段"
            title="标记所需片段并下载到本机"
          />
        }
      >
        <DownloadIcon data-icon="inline-start" />
        <span className="control-label">下载片段</span>
      </DialogTrigger>
      <DialogContent
        container={portal}
        className="save-setup-dialog clip-export-panel"
      >
        <DialogHeader>
          <DialogTitle>下载录像片段</DialogTitle>
          <DialogDescription>
            {source.channelName} · 录像时间（
            {source.timeZone ?? "Asia/Shanghai"}）
          </DialogDescription>
        </DialogHeader>
        <form
          className="clip-export-form"
          onSubmit={(event) => {
            event.preventDefault()
            const range = selection()
            if (!range) return
            setOpen(false)
            void start({
              mode: "history",
              ...source,
              ...range,
            })
          }}
        >
          <ScrollArea className="save-setup-scroll">
            <FieldGroup className="save-setup-content gap-3">
              <SaveCapabilityNotice />
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={`${id}-start`}>录像开始时间</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id={`${id}-start`}
                    aria-label="片段起点"
                    value={from}
                    aria-invalid={!!error}
                    placeholder="YYYY-MM-DD HH:mm:ss"
                    onChange={(event) =>
                      change("start", event.currentTarget.value)
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="将当前位置设为起点"
                    onClick={() => mark("start", position)}
                  >
                    <FlagIcon data-icon="inline-start" />
                    设为起点
                  </Button>
                </div>
              </Field>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={`${id}-end`}>录像结束时间</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id={`${id}-end`}
                    aria-label="片段终点"
                    value={to}
                    aria-invalid={!!error}
                    placeholder="YYYY-MM-DD HH:mm:ss"
                    onChange={(event) =>
                      change("end", event.currentTarget.value)
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="将当前位置设为终点"
                    onClick={() => mark("end", position)}
                  >
                    <FlagIcon data-icon="inline-start" />
                    设为终点
                  </Button>
                </div>
              </Field>
              {max !== undefined &&
                max > 0 &&
                a !== undefined &&
                b !== undefined &&
                valid && (
                  <Field>
                    <FieldLabel>调整选区</FieldLabel>
                    <Slider
                      aria-label="下载选区"
                      min={0}
                      max={max}
                      step={1}
                      value={[
                        Math.max(0, Math.min(a, max)),
                        Math.max(0, Math.min(b, max)),
                      ]}
                      onValueChange={(value) => {
                        if (!Array.isArray(value)) return
                        change("start", clock(value[0]))
                        change(
                          "end",
                          clock(Math.min(value[1], duration ?? max), "ceil")
                        )
                      }}
                    />
                  </Field>
                )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={a === undefined}
                  onClick={() => {
                    if (a !== undefined)
                      change("start", clock(Math.max(0, a - 30)))
                  }}
                >
                  前扩 30 秒
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={b === undefined}
                  onClick={() => {
                    if (b !== undefined)
                      change(
                        "end",
                        clock(Math.min(duration ?? b + 30, b + 30), "ceil")
                      )
                  }}
                >
                  后扩 30 秒
                </Button>
              </div>
              <FieldDescription>
                {source.fileStartAt
                  ? `可下载范围：${clock(0)}${duration === undefined ? " 起（终点待确认）" : ` — ${clock(duration, "ceil")}`}。`
                  : "尚未确认录像文件的起始时间。"}
                仅限当前录像文件，按以上时区输入完整日期和时分秒。
              </FieldDescription>
              <FieldDescription>
                {a !== undefined && b !== undefined && valid
                  ? `时长 ${mediaClock(b - a)} · `
                  : ""}
                原速，保留源音轨。
                实际保存范围可能比选区略宽，时间以设备录像标记为准。
              </FieldDescription>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </FieldGroup>
          </ScrollArea>
          <div className="save-setup-actions">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit">
              <DownloadIcon data-icon="inline-start" />
              保存选区
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
