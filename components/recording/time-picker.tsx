"use client"

import { useEffect, useMemo, useState, type RefObject } from "react"
import { ClockIcon } from "lucide-react"
import { Temporal } from "@js-temporal/polyfill"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { WheelPicker, WheelPickerWrapper } from "@/components/wheel-picker"
import { recordingTimeOfDay } from "@/lib/browser-save/recording-time"

export function RecordingTimePicker({
  id,
  label,
  date,
  value,
  min,
  max,
  invalid,
  container,
  onChange,
}: {
  id: string
  label: string
  date: string
  value: string
  min: string
  max: string
  invalid?: boolean
  container?: RefObject<HTMLDivElement | null>
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReducedMotion(preference.matches)
    update()
    preference.addEventListener("change", update)
    return () => preference.removeEventListener("change", update)
  }, [])
  const time = recordingTimeOfDay(value, date)
  const lowerBound = recordingTimeOfDay(min, date)
  const upperBound = recordingTimeOfDay(max, date)
  const parts = time.split(":")
  // Stable options keep playback time updates from resetting an active gesture.
  const columns = useMemo(() => {
    const time = recordingTimeOfDay(value, date)
    const lowerBound = recordingTimeOfDay(min, date)
    const upperBound = recordingTimeOfDay(max, date)
    const values = time.split(":")
    return ["时", "分", "秒"].map((unit, index) => ({
      unit,
      options: Array.from(
        { length: index === 0 ? (upperBound === "24:00:00" ? 25 : 24) : 60 },
        (_, number) => {
          const option = String(number).padStart(2, "0")
          const prefix = [...values.slice(0, index), option]
          const lower = [...prefix, ...Array(2 - index).fill("00")].join(":")
          const upper = [...prefix, ...Array(2 - index).fill("59")].join(":")
          return {
            value: option,
            label: `${option} ${unit}`,
            disabled: upper < lowerBound || lower > upperBound,
          }
        }
      ),
    }))
  }, [value, min, max, date])
  function change(next: string) {
    const selected =
      next < lowerBound ? lowerBound : next > upperBound ? upperBound : next
    onChange(
      selected === "24:00:00"
        ? `${Temporal.PlainDate.from(date).add({ days: 1 })} 00:00:00`
        : `${date} ${selected}`
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            className="min-w-0 flex-1 justify-start"
            aria-label={label}
            aria-invalid={invalid}
            disabled={!min || !max}
          />
        }
      >
        <ClockIcon data-icon="inline-start" />
        {time || "选择时间"}
      </PopoverTrigger>
      <PopoverContent container={container} align="start" className="w-64">
        <PopoverTitle>选择{label}</PopoverTitle>
        <WheelPickerWrapper>
          {columns.map(({ unit, options }, index) => (
            <WheelPicker
              key={unit}
              id={`${id}-${index}`}
              label={`${label}${unit}`}
              options={options}
              value={parts[index]}
              visibleCount={12}
              optionItemHeight={32}
              scrollSensitivity={reducedMotion ? 10000 : 5}
              dragSensitivity={reducedMotion ? 10000 : 3}
              onValueChange={(next) => {
                if (!next) return
                change(
                  parts
                    .map((part, at) => (at === index ? next : part))
                    .join(":")
                )
              }}
            />
          ))}
        </WheelPickerWrapper>
        <Button type="button" onClick={() => setOpen(false)}>
          完成时间选择
        </Button>
      </PopoverContent>
    </Popover>
  )
}
