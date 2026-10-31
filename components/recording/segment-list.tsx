"use client"

import { ChevronDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { RecordingConsoleState } from "@/hooks/use-recording-console"
import type { Recordings } from "@/shared/contracts"
import { clock, duration, segmentEnd } from "./format"

type SegmentListProps = Pick<
  RecordingConsoleState,
  "selected" | "listOpen" | "toggleList" | "selectSegment"
> & { data: Recordings }

export function RecordingSegmentList({
  data,
  selected,
  listOpen,
  toggleList,
  selectSegment,
}: SegmentListProps) {
  return (
    <section className="segment-list min-w-0" aria-label="录像片段列表">
      <Button
        type="button"
        variant="ghost"
        aria-expanded={listOpen}
        aria-controls="recording-segments"
        onClick={toggleList}
      >
        片段列表
        <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
      </Button>
      {listOpen && (
        <ol
          id="recording-segments"
          className="mt-2 overflow-hidden rounded-md border bg-card"
        >
          {data.segments.map((item, index) => (
            <li key={item.id} className="[&:last-child>button]:border-b-0">
              <Button
                type="button"
                variant={selected === item.id ? "secondary" : "ghost"}
                aria-label={`选择片段 ${index + 1}，${clock(item.startAt, data.timeZone)} 至 ${segmentEnd(item.endAt, data)}`}
                aria-pressed={selected === item.id}
                className={cn(
                  "segment-row grid h-auto w-full grid-cols-[1.625rem_minmax(0,1fr)_7rem] items-center gap-3.5 rounded-none border-b px-4 py-3 text-left whitespace-normal max-md:grid-cols-[1.25rem_minmax(0,1fr)] max-md:gap-x-2 max-md:gap-y-1 max-md:p-3"
                )}
                onClick={() => selectSegment(item.id)}
              >
                <span className="text-[0.6875rem] text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="tabular-nums">
                  {clock(item.startAt, data.timeZone)} —{" "}
                  {segmentEnd(item.endAt, data)}
                </span>
                <span className="text-xs text-muted-foreground max-md:col-start-2">
                  {duration(Date.parse(item.endAt) - Date.parse(item.startAt))}
                </span>
              </Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
