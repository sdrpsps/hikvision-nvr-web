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
import { RecordingTimePicker } from "@/components/recording/time-picker"
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
import { recordingTimeOfDay } from "@/lib/browser-save/recording-time"
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
  const {
    from,
    to,
    a,
    b,
    valid,
    min,
    max,
    first,
    last,
    error,
    clock,
    clamp,
    change,
    mark,
    selection,
  } = useClipSelection(
    source.fileStartAt,
    source.timeZone,
    duration,
    source.date
  )
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
            {first && last
              ? `片段范围：${recordingTimeOfDay(first, source.date)} — ${recordingTimeOfDay(last, source.date)}${duration === undefined ? "（文件终点待确认）" : ""}`
              : "尚未确认当天可下载的录像范围。"}
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
              {(
                [
                  {
                    which: "start",
                    name: "起点",
                    label: "录像开始时间",
                    value: from,
                  },
                  {
                    which: "end",
                    name: "终点",
                    label: "录像结束时间",
                    value: to,
                  },
                ] as const
              ).map(({ which, name, label, value }) => (
                <Field key={which} data-invalid={!!error}>
                  <FieldLabel htmlFor={`${id}-${which}`}>{label}</FieldLabel>
                  <div className="flex gap-2">
                    <RecordingTimePicker
                      id={`${id}-${which}`}
                      label={`片段${name}`}
                      date={source.date}
                      value={value}
                      min={first}
                      max={last}
                      invalid={!!error}
                      container={portal}
                      onChange={(next) => change(which, next)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={`将当前位置设为${name}`}
                      onClick={() => mark(which, position)}
                    >
                      <FlagIcon data-icon="inline-start" />
                      设为{name}
                    </Button>
                  </div>
                </Field>
              ))}
              {max !== undefined &&
                max > 0 &&
                a !== undefined &&
                b !== undefined &&
                valid && (
                  <Field>
                    <FieldLabel>调整选区</FieldLabel>
                    <Slider
                      aria-label="下载选区"
                      min={min}
                      max={max}
                      step={1}
                      value={[
                        Math.max(min, Math.min(a, max)),
                        Math.max(min, Math.min(b, max)),
                      ]}
                      onValueChange={(value) => {
                        if (!Array.isArray(value)) return
                        change("start", clock(clamp(value[0])))
                        change("end", clock(clamp(value[1]), "ceil"))
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
                    if (a !== undefined) change("start", clock(clamp(a - 30)))
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
                      change("end", clock(clamp(b + 30), "ceil"))
                  }}
                >
                  后扩 30 秒
                </Button>
              </div>
              <FieldDescription>
                {a !== undefined && b !== undefined && valid
                  ? `时长 ${mediaClock(b - a)} · `
                  : ""}
                实际保存范围可能略宽。
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
