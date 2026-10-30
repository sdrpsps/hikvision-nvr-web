"use client"

/*
 * Adapter based on https://chanhdai.com/r/wheel-picker.json
 * MIT License — Copyright (c) 2025 ncdai
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import "@ncdai/react-wheel-picker/style.css"

import { useEffect, useRef, type ComponentProps } from "react"
import * as WheelPickerPrimitive from "@ncdai/react-wheel-picker"

import { cn } from "@/lib/utils"

type WheelPickerValue = WheelPickerPrimitive.WheelPickerValue

type WheelPickerOption<T extends WheelPickerValue = string> =
  WheelPickerPrimitive.WheelPickerOption<T>

type WheelPickerClassNames = WheelPickerPrimitive.WheelPickerClassNames

function WheelPickerWrapper({
  className,
  ...props
}: ComponentProps<typeof WheelPickerPrimitive.WheelPickerWrapper>) {
  return (
    <WheelPickerPrimitive.WheelPickerWrapper
      className={cn(
        "w-full rounded-lg border border-border bg-background px-1 shadow-xs",
        className
      )}
      {...props}
    />
  )
}

function WheelPicker<T extends WheelPickerValue = string>({
  id,
  label,
  classNames,
  ...props
}: WheelPickerPrimitive.WheelPickerProps<T> & { id: string; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    // The upstream primitive does not forward DOM attributes or a ref.
    // Attach numeric time-field semantics to its existing keyboard focus target.
    const element = host.current?.querySelector<HTMLElement>("[data-rwp]")
    if (!element) return
    const enabled = props.options.filter((option) => !option.disabled)
    const selected = props.options.find(
      (option) => option.value === props.value
    )
    element.id = id
    element.setAttribute("role", "spinbutton")
    element.setAttribute("aria-label", label)
    element.setAttribute(
      "aria-valuemin",
      String(Number(enabled[0]?.value ?? 0))
    )
    element.setAttribute(
      "aria-valuemax",
      String(Number(enabled.at(-1)?.value ?? 0))
    )
    element.setAttribute("aria-valuenow", String(Number(props.value ?? 0)))
    element.setAttribute(
      "aria-valuetext",
      String(selected?.label ?? props.value)
    )
  }, [id, label, props.value, props.options])
  return (
    <div ref={host} className="group/wheel min-w-0 flex-1">
      <WheelPickerPrimitive.WheelPicker
        classNames={{
          optionItem: cn(
            "text-muted-foreground data-disabled:opacity-40",
            classNames?.optionItem
          ),
          highlightWrapper: cn(
            "bg-muted text-foreground",
            "group-has-[:focus-visible]/wheel:inset-ring-2 group-has-[:focus-visible]/wheel:inset-ring-ring",
            classNames?.highlightWrapper
          ),
          highlightItem: cn(
            "data-disabled:opacity-40",
            classNames?.highlightItem
          ),
        }}
        {...props}
        onValueChange={(next) => {
          // A late inertia callback must not change a closed picker's selection.
          if (mounted.current) props.onValueChange?.(next)
        }}
      />
    </div>
  )
}

export { WheelPicker, WheelPickerWrapper }
export type { WheelPickerClassNames, WheelPickerOption }
