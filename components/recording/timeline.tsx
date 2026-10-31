"use client"

import type { ReactNode } from "react"
import type { Recordings } from "@/shared/contracts"
import { useRecordingScrub } from "@/hooks/use-recording-scrub"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import { clock, segmentEnd } from "./format"

export function RecordingTimeline({
  data,
  selected,
  requestedAt,
  playbackAt,
  active,
  onSelect,
  zoom,
  zoomControls,
}: {
  data: Recordings
  selected: string
  requestedAt?: string
  playbackAt?: string
  active?: boolean
  onSelect: (id: string, at?: string) => void
  zoom: number
  zoomControls?: ReactNode
}) {
  const { scrub, start, total, max, currentAt, value, sliderEvents } =
    useRecordingScrub({ data, requestedAt, playbackAt, onSelect })
  const ticks = Array.from(
    { length: Math.ceil(total / 3600000) + 1 },
    (_, index) => Math.min(index * 3600000, total)
  )
  const shownAt =
    scrub !== undefined
      ? new Date(start + value * 1000).toISOString()
      : (currentAt ?? data.range.startAt)
  const shownOutsideDay =
    Date.parse(shownAt) < start || Date.parse(shownAt) >= start + total
  const timeText = shownOutsideDay
    ? `${new Intl.DateTimeFormat("zh-CN", {
        timeZone: data.timeZone,
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(shownAt))} ${clock(shownAt, data.timeZone)}`
    : clock(shownAt, data.timeZone)
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 max-md:gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex items-baseline gap-1.5 text-xs tabular-nums [&>span]:text-muted-foreground">
            <span>
              {scrub !== undefined
                ? "选择时间"
                : playbackAt
                  ? "回放时间"
                  : active && requestedAt
                    ? "正在定位"
                    : requestedAt
                      ? "回放时间"
                      : "选择时间"}
            </span>
            <time dateTime={shownAt} aria-label="当前回放时间">
              {timeText}
            </time>
          </div>
        </div>
        {zoomControls}
      </div>
      <ScrollArea
        className="timeline-scroll-area -mx-2.5 min-w-0"
        scrollbars="horizontal"
        contentProps={{ style: { minWidth: "fit-content" } }}
        viewportProps={{
          className: "px-2.5 pt-1 pb-2.5",
          tabIndex: 0,
          role: "region",
          "aria-label": "全天录像时间轴，可横向滚动",
        }}
      >
        <div
          className="timeline-chart px-2.5 py-1"
          style={{ minWidth: `${Math.max(640, 760 * zoom)}px` }}
        >
          <div className="relative h-6 text-[0.6875rem] text-muted-foreground tabular-nums [&>span]:absolute [&>span]:-translate-x-1/2 [&>span]:whitespace-nowrap">
            {ticks.map((offset, index) => (
              <span key={offset} style={{ left: `${(offset / total) * 100}%` }}>
                {index % 2 === 0 || offset === total
                  ? offset === total
                    ? "24:00"
                    : clock(
                        new Date(start + offset).toISOString(),
                        data.timeZone
                      ).slice(0, 5)
                  : ""}
              </span>
            ))}
          </div>
          <div className="relative h-10 rounded-sm border bg-muted">
            {ticks.map((offset) => (
              <span
                key={offset}
                className="absolute h-full w-px bg-border"
                style={{ left: `${(offset / total) * 100}%` }}
              />
            ))}
            {data.segments.map((segment, index) => {
              const a = Math.max(start, Date.parse(segment.startAt)),
                b = Math.min(start + total, Date.parse(segment.endAt))
              return (
                <span
                  key={segment.id}
                  className={cn(
                    "timeline-segment pointer-events-none absolute top-2 bottom-2 min-w-0.5 border-r bg-[var(--recording)]",
                    selected === segment.id &&
                      "is-selected selected-segment bg-[var(--recording-selected)]"
                  )}
                  style={{
                    left: `${((a - start) / total) * 100}%`,
                    width: `${((b - a) / total) * 100}%`,
                  }}
                  aria-label={`片段 ${index + 1}，${clock(segment.startAt, data.timeZone)} 至 ${segmentEnd(segment.endAt, data)}`}
                  title={`${clock(segment.startAt, data.timeZone)} — ${segmentEnd(segment.endAt, data)}`}
                />
              )
            })}
            <Slider
              className="absolute inset-0 [&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-thumb]]:h-12 [&_[data-slot=slider-thumb]]:w-1.5 [&_[data-slot=slider-thumb]]:rounded-sm [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:bg-primary [&_[data-slot=slider-track]]:h-full [&_[data-slot=slider-track]]:rounded-none [&_[data-slot=slider-track]]:bg-transparent [&>div]:h-full"
              aria-label="回放时间轴"
              getAriaValueText={(_formatted, seconds) =>
                clock(
                  new Date(start + seconds * 1000).toISOString(),
                  data.timeZone
                )
              }
              value={[value]}
              min={0}
              max={max}
              step={1}
              disabled={!data.segments.length}
              {...sliderEvents}
            />
          </div>
        </div>
      </ScrollArea>
    </>
  )
}
