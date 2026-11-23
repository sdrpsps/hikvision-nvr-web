"use client"

import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react"
import { ClockIcon } from "lucide-react"
import { Temporal } from "@js-temporal/polyfill"
import { cn } from "@/lib/utils"
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
  disabled,
  container,
  triggerText,
  title,
  size,
  className,
  onOpenChange,
  onChange,
  onCommit,
}: {
  id: string
  label: string
  date: string
  value: string
  min: string
  max: string
  invalid?: boolean
  disabled?: boolean
  container?: RefObject<HTMLDivElement | null>
  triggerText?: ReactNode
  title?: string
  size?: ComponentProps<typeof Button>["size"]
  className?: string
  onOpenChange?: (open: boolean) => void
  onChange?: (value: string) => void
  onCommit?: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string>()
  const [fullscreen, setFullscreen] = useState<HTMLElement | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReducedMotion(preference.matches)
    update()
    preference.addEventListener("change", update)
    return () => preference.removeEventListener("change", update)
  }, [])
  useEffect(() => {
    if (container) return
    const update = () =>
      setFullscreen(
        document.fullscreenElement instanceof HTMLElement
          ? document.fullscreenElement
          : null
      )
    update()
    document.addEventListener("fullscreenchange", update)
    return () => document.removeEventListener("fullscreenchange", update)
  }, [container])
  const activeValue = open && !onChange && draft !== undefined ? draft : value
  const time = recordingTimeOfDay(activeValue, date)
  const lowerBound = recordingTimeOfDay(min, date)
  const upperBound = recordingTimeOfDay(max, date)
  const parts = time.split(":")
  // Stable options keep playback time updates from resetting an active gesture.
  const columns = useMemo(() => {
    const current = recordingTimeOfDay(activeValue, date)
    const lowerBound = recordingTimeOfDay(min, date)
    const upperBound = recordingTimeOfDay(max, date)
    const values = current.split(":")
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
  }, [activeValue, min, max, date])
  function formatClockValue(clockTime: string) {
    const selected =
      clockTime < lowerBound
        ? lowerBound
        : clockTime > upperBound
          ? upperBound
          : clockTime
    return selected === "24:00:00"
      ? `${Temporal.PlainDate.from(date).add({ days: 1 })} 00:00:00`
      : `${date} ${selected}`
  }
  function change(next: string) {
    const formatted = formatClockValue(next)
    if (open) setDraft(formatted)
    onChange?.(formatted)
  }
  const portalContainer = container ?? fullscreen ?? undefined
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        setDraft(
          nextOpen
            ? formatClockValue(recordingTimeOfDay(value, date) || lowerBound)
            : undefined
        )
        onOpenChange?.(nextOpen)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            size={size}
            className={cn("min-w-0 flex-1 justify-start", className)}
            aria-label={label}
            title={title}
            aria-invalid={invalid}
            disabled={disabled || !min || !max}
          />
        }
      >
        <ClockIcon data-icon="inline-start" />
        {triggerText ?? (time || "选择时间")}
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        align="start"
        className="w-64"
      >
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
        <Button
          type="button"
          onClick={() => {
            const committed = draft ?? value
            setOpen(false)
            setDraft(undefined)
            onCommit?.(committed)
          }}
        >
          完成时间选择
        </Button>
      </PopoverContent>
    </Popover>
  )
}
