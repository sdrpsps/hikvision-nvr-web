"use client"

import { useId, useState, type RefObject } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  const [error, setError] = useState("")
  const id = useId()
  function apply(rate: number) {
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) {
      setError("请输入 0.25–4 之间的倍速。")
      return
    }
    rate = Math.round(rate * 100) / 100
    if (!onChange(rate)) {
      setError("浏览器不支持此倍速。")
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
        container={container}
        side="top"
        align="start"
        className="w-60"
      >
        <PopoverTitle>播放倍速</PopoverTitle>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-preset`} className="sr-only">
              倍速档位
            </FieldLabel>
            <Select
              items={[
                ...rates.map((rate) => ({
                  label: `${rate}×`,
                  value: String(rate),
                })),
                { label: "自定义", value: "custom" },
              ]}
              value={rates.includes(value) ? String(value) : "custom"}
              onValueChange={(next) => {
                if (next !== null && next !== "custom") apply(Number(next))
              }}
            >
              <SelectTrigger id={`${id}-preset`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent container={container} alignItemWithTrigger={false}>
                <SelectGroup>
                  {rates.map((rate) => (
                    <SelectItem key={rate} value={String(rate)}>
                      {rate}×
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field data-invalid={!!error}>
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
            {error && (
              <p
                id={`${id}-error`}
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </Field>
        </FieldGroup>
      </PopoverContent>
    </Popover>
  )
}
