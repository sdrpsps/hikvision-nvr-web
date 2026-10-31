"use client"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { RecordingConsoleState } from "@/hooks/use-recording-console"
import type { Recordings } from "@/shared/contracts"
import { cn } from "@/lib/utils"
import { duration } from "./format"
import { RecordingTimeline } from "./timeline"

type DistributionProps = Pick<
  RecordingConsoleState,
  | "selected"
  | "requestedTime"
  | "playbackAt"
  | "active"
  | "zoom"
  | "setZoom"
  | "selectSegment"
  | "dataUpdatedAt"
> & { data: Recordings; selectionKey: string; embedded?: boolean }

export function RecordingDistribution({
  data,
  selected,
  requestedTime,
  playbackAt,
  active,
  zoom,
  setZoom,
  selectSegment,
  dataUpdatedAt,
  selectionKey,
  embedded = false,
}: DistributionProps) {
  // This is a query snapshot. Future hours are neither covered nor missing yet.
  const observedEnd = data
    ? Math.min(Date.parse(data.range.endAt), dataUpdatedAt)
    : 0
  const coverage =
    data?.coverage.reduce(
      (sum, item) =>
        sum +
        Math.max(
          0,
          Math.min(Date.parse(item.endAt), observedEnd) -
            Date.parse(item.startAt)
        ),
      0
    ) ?? 0
  const gaps =
    data?.gaps.filter(
      (item) =>
        Date.parse(item.startAt) < Math.min(Date.parse(item.endAt), observedEnd)
    ) ?? []
  return (
    <section
      className={cn(
        "recording-distribution p-4 max-md:p-3 video-fullscreen:col-start-1 video-fullscreen:row-start-2 video-fullscreen:w-full video-fullscreen:shrink-0 video-fullscreen:rounded-none video-fullscreen:bg-card video-fullscreen:px-4 video-fullscreen:py-3",
        embedded
          ? "rounded-none border-x-0 border-t border-b-0"
          : "rounded-lg border bg-card"
      )}
      aria-label="回放时间轴区域"
    >
      <RecordingTimeline
        key={selectionKey}
        data={data}
        selected={selected}
        requestedAt={requestedTime?.at}
        playbackAt={playbackAt}
        active={active}
        zoomControls={
          <ToggleGroup
            aria-label="时间轴缩放"
            value={[zoom]}
            onValueChange={(values) => {
              if (values[0] === "1" || values[0] === "2" || values[0] === "4")
                setZoom(values[0])
            }}
            variant="outline"
            size="sm"
            spacing={0}
          >
            <ToggleGroupItem value="1">全天</ToggleGroupItem>
            <ToggleGroupItem value="2">2 倍</ToggleGroupItem>
            <ToggleGroupItem value="4">4 倍</ToggleGroupItem>
          </ToggleGroup>
        }
        onSelect={selectSegment}
        zoom={Number(zoom)}
      />
      <div className="coverage-summary mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground [&_strong]:ml-1.5 [&_strong]:font-medium [&_strong]:text-foreground">
        <span>{data.segments.length} 个录像片段</span>
        <span>
          覆盖 <strong>{duration(coverage)}</strong>
        </span>
        {gaps.length > 0 && (
          <span>
            缺口 <strong>{gaps.length} 处</strong>
          </span>
        )}
        {observedEnd < Date.parse(data.range.endAt) && (
          <span>截至本次查询</span>
        )}
      </div>
    </section>
  )
}
