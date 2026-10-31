"use client"

import { RefreshCwIcon } from "lucide-react"
import type { RecordingConsoleState } from "@/hooks/use-recording-console"
import { ChannelSidebarToggle } from "@/components/channel-sidebar"
import { RecordingDatePicker } from "@/components/recording/date-picker"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { DeviceDetails } from "./device-details"

type QueryBarProps = Pick<
  RecordingConsoleState,
  | "resources"
  | "date"
  | "validDate"
  | "sidebarOpen"
  | "toggleSidebar"
  | "setDate"
  | "refreshQueries"
>

export function RecordingQueryBar({
  resources,
  date,
  validDate,
  sidebarOpen,
  toggleSidebar,
  setDate,
  refreshQueries,
}: QueryBarProps) {
  return (
    <section
      className="playback-query-bar mb-4 flex flex-wrap items-center gap-x-6 gap-y-4 max-[1100px]:gap-x-4 max-[1100px]:gap-y-3 max-md:gap-3"
      aria-label="检索录像"
    >
      <ChannelSidebarToggle
        open={sidebarOpen}
        controls="playback-channels"
        onToggle={toggleSidebar}
      />
      <FieldGroup className="flex w-auto flex-row items-center gap-4 max-[1100px]:gap-3 max-md:min-w-0 max-md:flex-1 max-md:flex-wrap [&_[data-slot=field-label]]:whitespace-nowrap [&>[data-slot=field]]:flex [&>[data-slot=field]]:w-auto [&>[data-slot=field]]:flex-row [&>[data-slot=field]]:items-center [&>[data-slot=field]]:gap-2 max-md:[&>[data-slot=field]]:min-w-[8.5rem] max-md:[&>[data-slot=field]]:flex-1 max-md:[&>[data-slot=field]]:flex-col max-md:[&>[data-slot=field]]:items-stretch max-md:[&>[data-slot=field]]:gap-1.5 [&>[data-slot=field]>[data-slot=field-label]]:w-auto [&>[data-slot=field]>[data-slot=field-label]]:flex-none">
        <Field data-invalid={!!date && !validDate} data-disabled={!resources}>
          <FieldLabel htmlFor="date" className="sr-only">
            日期
          </FieldLabel>
          <RecordingDatePicker
            id="date"
            value={date}
            timeZone={resources?.timeZone ?? "Asia/Shanghai"}
            onChange={(value) => {
              setDate(value)
            }}
            disabled={!resources}
          />
        </Field>
      </FieldGroup>
      <div className="query-actions ml-auto flex items-center gap-3 max-md:w-full max-md:justify-between">
        <DeviceDetails
          channelCount={resources?.channels.length}
          timeZone={resources?.timeZone}
        />
        <Button variant="outline" onClick={refreshQueries}>
          <RefreshCwIcon data-icon="inline-start" />
          刷新
        </Button>
      </div>
      {!!date && !validDate && (
        <p className="w-full text-sm text-destructive" role="alert">
          请选择有效的日期。
        </p>
      )}
    </section>
  )
}
