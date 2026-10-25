"use client"

import { useId, useState, type RefObject } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useFullscreenContainer } from "@/hooks/use-fullscreen-container"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"

const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4]

export function PlaybackRate({
  value,
  onChange,
  container,
}: {
  value: number
  onChange: (rate: number) => boolean
  container: RefObject<HTMLDivElement | null>
}) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(String(value))
  const [customMode, setCustomMode] = useState(!rates.includes(value))
  const [error, setError] = useState("")
  const id = useId()
  const portalContainer = useFullscreenContainer(container)
  function apply(rate: number) {
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) {
      setError("请输入 0.25–4 之间的倍速。")
      return
    }
    rate = Math.round(rate * 100) / 100
    if (!onChange(rate)) {
      setError("")
      toast.error("浏览器不支持此倍速。", { id: `playback-rate-${id}` })
      return
    }
    setError("")
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setCustom(String(value))
          setCustomMode(!rates.includes(value))
          setError("")
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="播放倍速"
            title="播放倍速"
          />
        }
      >
        {value}×
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        side="top"
        align="start"
        className="w-60"
      >
        <PopoverTitle>播放倍速</PopoverTitle>
        <FieldGroup>
          <Field>
            <FieldLabel id={`${id}-preset`} className="sr-only">
              倍速档位
            </FieldLabel>
            <ToggleGroup
              aria-labelledby={`${id}-preset`}
              className="grid w-full grid-cols-4"
              value={rates.includes(value) ? [String(value)] : []}
              variant="outline"
              size="sm"
              onValueChange={(values) => {
                if (values[0]) apply(Number(values[0]))
              }}
            >
              {rates.map((rate) => (
                <ToggleGroupItem key={rate} value={String(rate)}>
                  {rate}×
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Button
            variant="ghost"
            className="justify-start"
            aria-expanded={customMode}
            aria-controls={`${id}-custom-form`}
            onClick={() => {
              setCustomMode((shown) => !shown)
              setError("")
            }}
          >
            自定义…
          </Button>
          {customMode && (
            <Field data-invalid={!!error} id={`${id}-custom-form`}>
              <FieldLabel htmlFor={`${id}-custom`}>自定义倍速</FieldLabel>
              <form
                className="flex items-center gap-2"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault()
                  apply(custom.trim() ? Number(custom) : NaN)
                }}
              >
                <Input
                  id={`${id}-custom`}
                  type="number"
                  min="0.25"
                  max="4"
                  step="0.01"
                  value={custom}
                  aria-invalid={!!error}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(event) => {
                    setCustom(event.target.value)
                    setError("")
                  }}
                />
                <Button type="submit" size="sm">
                  应用
                </Button>
              </form>
            </Field>
          )}
          {error && (
            <p
              id={`${id}-error`}
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </FieldGroup>
      </PopoverContent>
    </Popover>
  )
}
