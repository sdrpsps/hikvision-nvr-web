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
    <section className="segment-list" aria-label="录像片段列表">
      <Button
        type="button"
        variant="ghost"
        className="segment-list-toggle"
        aria-expanded={listOpen}
        aria-controls="recording-segments"
        onClick={toggleList}
      >
        片段列表
        <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
      </Button>
      {listOpen && (
        <ol id="recording-segments">
          {data.segments.map((item, index) => (
            <li key={item.id}>
              <Button
                type="button"
                variant={selected === item.id ? "secondary" : "ghost"}
                aria-label={`选择片段 ${index + 1}，${clock(item.startAt, data.timeZone)} 至 ${segmentEnd(item.endAt, data)}`}
                aria-pressed={selected === item.id}
                className={cn(
                  "segment-row",
                  selected === item.id && "is-selected"
                )}
                onClick={() => selectSegment(item.id)}
              >
                <span className="segment-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="segment-time">
                  {clock(item.startAt, data.timeZone)} —{" "}
                  {segmentEnd(item.endAt, data)}
                </span>
                <span className="segment-duration">
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
