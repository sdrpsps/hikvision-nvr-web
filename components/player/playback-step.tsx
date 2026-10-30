"use client"

import { useEffect, useState, type RefObject } from "react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { useFullscreenContainer } from "@/hooks/use-fullscreen-container"
import type { PlaybackPreferences } from "./types"

export function PlaybackStep({
  container,
  initialValue = 0.5,
  onStep,
  onPreferencesChange,
}: {
  container: RefObject<HTMLDivElement | null>
  initialValue?: number
  onStep: (delta: number) => void
  onPreferencesChange?: (preferences: Partial<PlaybackPreferences>) => void
}) {
  const [value, setValue] = useState(
    Number.isFinite(initialValue) && initialValue >= 0.1 && initialValue <= 2
      ? Math.round(initialValue * 10) / 10
      : 0.5
  )
  const [open, setOpen] = useState(false)
  const portalContainer = useFullscreenContainer(container)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest(
            'input, textarea, select, [role="slider"], [role="combobox"], [role="spinbutton"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tablist"], [role="toolbar"], [data-slot="popover-content"]'
          ))
      )
        return
      if (
        document.querySelector(
          '[role="dialog"]:not([data-closed]), [role="alertdialog"]:not([data-closed])'
        )
      )
        return
      event.preventDefault()
      onStep(event.key === "ArrowLeft" ? -value : value)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onStep, value])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="回放步长"
            title="左右方向键按步长后退或前进"
          />
        }
      >
        步长 {value} 秒
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        side="top"
        align="start"
        className="w-64"
        onKeyDownCapture={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
          )
            return
          event.preventDefault()
          event.stopPropagation()
          onStep(event.key === "ArrowLeft" ? -value : value)
        }}
      >
        <PopoverTitle>回放步长</PopoverTitle>
        <PopoverDescription>
          鼠标拖动设置步长，← 后退 / → 前进。暂停时步进后保持暂停。
        </PopoverDescription>
        <div className="flex items-center justify-between">
          <span>步长</span>
          <output>{value.toFixed(1)} 秒</output>
        </div>
        <Slider
          aria-label="步长秒数"
          value={[value]}
          min={0.1}
          max={2}
          step={0.1}
          getAriaValueText={(_formatted, seconds) => `${seconds.toFixed(1)} 秒`}
          onValueChange={(values) => {
            const raw = Array.isArray(values) ? values[0] : values
            if (!Number.isFinite(raw) || raw < 0.1 || raw > 2) return
            const next = Math.round(raw * 10) / 10
            setValue(next)
            onPreferencesChange?.({ stepSeconds: next })
          }}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>0.1 秒</span>
          <span>每档 0.1 秒</span>
          <span>2 秒</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
