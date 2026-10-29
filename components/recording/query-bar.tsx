"use client"

import { RefreshCwIcon } from "lucide-react"
import type { RecordingConsoleState } from "@/hooks/use-recording-console"
import { ChannelSidebarToggle } from "@/components/channel-sidebar"
import { RecordingDatePicker } from "@/components/recording-date-picker"
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
    <section className="playback-query-bar" aria-label="检索录像">
      <ChannelSidebarToggle
        open={sidebarOpen}
        controls="playback-channels"
        onToggle={toggleSidebar}
      />
      <FieldGroup className="playback-query-fields">
        <Field data-invalid={!!date && !validDate} data-disabled={!resources}>
          <FieldLabel htmlFor="date">日期</FieldLabel>
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
      <div className="query-actions">
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
        <p className="text-sm text-destructive" role="alert">
          请选择有效的日期。
        </p>
      )}
    </section>
  )
}
