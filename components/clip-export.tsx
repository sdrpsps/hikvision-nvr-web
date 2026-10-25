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
import { mediaClock, parseMediaClock } from "@/lib/browser-save/types"

export type ClipSource = {
  track: string
  date: string
  segmentId: string
  channelName: string
  timeZone?: string
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
  const [from, setFrom] = useState("00:00:00")
  const [to, setTo] = useState("00:00:30")
  const [error, setError] = useState("")
  const id = useId()
  const portal = useFullscreenContainer(container)
  const a = parseMediaClock(from),
    b = parseMediaClock(to)
  const valid = a !== undefined && b !== undefined && b > a && b <= 86400
  function mark(which: "start" | "end") {
    if (which === "start") setFrom(mediaClock(position))
    else setTo(mediaClock(Math.ceil(position)))
    setError("")
  }
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
            {source.channelName} · {source.date}
          </DialogDescription>
        </DialogHeader>
        <form
          className="clip-export-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!valid) {
              setError(
                "请输入有效起止时间，终点必须晚于起点，最长不超过 24 小时。"
              )
              return
            }
            if (duration !== undefined && b > Math.ceil(duration)) {
              setError(`终点超出完整文件时长 ${mediaClock(duration)}。`)
              return
            }
            setError("")
            setOpen(false)
            void start({
              mode: "history",
              ...source,
              startSeconds: a,
              // Inputs and slider use whole seconds; the final displayed
              // second includes the file's fractional tail.
              endSeconds: duration === undefined ? b : Math.min(b, duration),
            })
          }}
        >
          <ScrollArea className="save-setup-scroll">
            <FieldGroup className="save-setup-content gap-3">
              <SaveCapabilityNotice />
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={`${id}-start`}>文件内起点</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id={`${id}-start`}
                    aria-label="片段起点"
                    value={from}
                    aria-invalid={!!error}
                    onChange={(event) => setFrom(event.currentTarget.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="将当前位置设为起点"
                    onClick={() => mark("start")}
                  >
                    <FlagIcon data-icon="inline-start" />
                    设为起点
                  </Button>
                </div>
              </Field>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={`${id}-end`}>文件内终点</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id={`${id}-end`}
                    aria-label="片段终点"
                    value={to}
                    aria-invalid={!!error}
                    onChange={(event) => setTo(event.currentTarget.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="将当前位置设为终点"
                    onClick={() => mark("end")}
                  >
                    <FlagIcon data-icon="inline-start" />
                    设为终点
                  </Button>
                </div>
              </Field>
              {duration !== undefined && duration > 0 && valid && (
                <Field>
                  <FieldLabel>调整选区</FieldLabel>
                  <Slider
                    aria-label="下载选区"
                    min={0}
                    max={Math.ceil(duration)}
                    step={1}
                    value={[
                      Math.min(a, Math.ceil(duration)),
                      Math.min(b, Math.ceil(duration)),
                    ]}
                    onValueChange={(value) => {
                      if (!Array.isArray(value)) return
                      setFrom(mediaClock(value[0]))
                      setTo(mediaClock(value[1]))
                      setError("")
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
                      setFrom(mediaClock(Math.max(0, a - 30)))
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
                      setTo(
                        mediaClock(
                          Math.min(Math.ceil(duration ?? 86400), b + 30)
                        )
                      )
                  }}
                >
                  后扩 30 秒
                </Button>
              </div>
              <FieldDescription>
                仅限当前文件，时间从文件开头计算。
              </FieldDescription>
              <FieldDescription>
                {valid ? `时长 ${mediaClock(b - a)} · ` : ""}原速，保留源音轨。
                实际范围可能略有扩展，以保存结果为准。
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
