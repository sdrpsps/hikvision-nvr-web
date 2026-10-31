"use client"

import type { LiveConsoleState } from "@/hooks/use-live-console"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LiveRecordButton } from "@/components/browser-save-provider"
import { StreamPlayer } from "@/components/preview-player"

type WindowProps = Pick<
  LiveConsoleState,
  | "selected"
  | "channels"
  | "timeZone"
  | "generation"
  | "trackFor"
  | "setSelected"
  | "setAssignments"
  | "registerPlayer"
  | "updateActivity"
> & { index: number }

export function LiveWindow({
  index,
  selected,
  channels,
  timeZone,
  generation,
  trackFor,
  setSelected,
  setAssignments,
  registerPlayer,
  updateActivity,
}: WindowProps) {
  return (
    <section
      className={cn(
        "live-window group/window @container relative flex w-full min-w-0 flex-col overflow-hidden rounded-sm border bg-card",
        selected === index && "border-primary shadow-[0_0_0_1px_var(--primary)]"
      )}
      aria-label={`窗口 ${index + 1}`}
      onFocusCapture={() => setSelected(index)}
      onPointerDown={() => setSelected(index)}
    >
      <div className="live-window-heading flex h-[var(--window-heading-height,2.125rem)] shrink-0 items-center gap-1 px-1.5 py-0.5">
        <Button
          className="shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`选择窗口 ${index + 1}`}
          aria-pressed={selected === index}
          onClick={() => setSelected(index)}
        >
          {index + 1}
        </Button>
        <Select
          items={[
            { label: "选择通道", value: "" },
            ...(channels?.map((channel) => ({
              label: channel.name,
              value: channel.id,
            })) ?? []),
          ]}
          value={trackFor(index)}
          disabled={!channels?.length}
          onValueChange={(value) =>
            setAssignments((old) => ({
              ...old,
              [index]: value ?? "",
            }))
          }
        >
          <SelectTrigger
            className="min-w-0 flex-1 border-transparent bg-transparent shadow-none"
            size="sm"
            aria-label={`窗口 ${index + 1} 通道`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              <SelectItem value="">选择通道</SelectItem>
              {channels?.map((channel) => (
                <SelectItem key={channel.id} value={channel.id}>
                  {channel.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <LiveRecordButton
          track={trackFor(index)}
          timeZone={timeZone}
          name={
            channels?.find((channel) => channel.id === trackFor(index))?.name ??
            "摄像头"
          }
        />
      </div>
      <StreamPlayer
        ref={(player) => registerPlayer(index, player)}
        key={`${generation}|${trackFor(index)}`}
        track={trackFor(index)}
        onActivityChange={(active) => updateActivity(index, active)}
        live
      />
    </section>
  )
}
