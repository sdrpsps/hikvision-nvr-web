"use client"

import { useState } from "react"
import { CalendarIcon } from "lucide-react"
import { TZDate } from "react-day-picker"
import { zhCN } from "react-day-picker/locale"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"

export function RecordingDatePicker({
  id,
  value,
  timeZone,
  disabled,
  onChange,
}: {
  id: string
  value: string
  timeZone: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  // A query date is a calendar day in the device timezone, not UTC midnight.
  const [year, month, day] = value.split("-").map(Number)
  const selected = value
    ? new TZDate(year, month - 1, day, timeZone)
    : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            disabled={disabled}
            className="w-full justify-start"
          />
        }
      >
        <CalendarIcon data-icon="inline-start" />
        {value || "选择日期"}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <PopoverTitle className="sr-only">选择日期</PopoverTitle>
        <Calendar
          mode="single"
          required
          autoFocus
          locale={zhCN}
          timeZone={timeZone}
          captionLayout="dropdown"
          defaultMonth={selected}
          selected={selected}
          onSelect={(next) => {
            onChange(
              new Intl.DateTimeFormat("en-CA", {
                timeZone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(next)
            )
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
