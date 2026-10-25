"use client"

import { RefreshCwIcon } from "lucide-react"
import type { RecordingConsoleState } from "@/hooks/use-recording-console"
import { RecordingDatePicker } from "@/components/recording-date-picker"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DeviceDetails } from "./device-details"

type QueryBarProps = Pick<
  RecordingConsoleState,
  | "resources"
  | "track"
  | "date"
  | "validDate"
  | "setTrack"
  | "setDate"
  | "refreshQueries"
>

export function RecordingQueryBar({
  resources,
  track,
  date,
  validDate,
  setTrack,
  setDate,
  refreshQueries,
}: QueryBarProps) {
  return (
    <section className="playback-query-bar" aria-label="检索录像">
      <FieldGroup className="playback-query-fields">
        <Field data-disabled={!resources?.channels.length}>
          <FieldLabel htmlFor="track">摄像头</FieldLabel>
          <Select
            items={
              resources?.channels.map((channel) => ({
                label: channel.name,
                value: channel.id,
              })) ?? []
            }
            value={track}
            onValueChange={(value) => {
              setTrack(value ?? "")
            }}
            disabled={!resources?.channels.length}
          >
            <SelectTrigger id="track" className="w-full">
              <SelectValue placeholder="暂无可用摄像头" />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {resources?.channels.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    {channel.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
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
