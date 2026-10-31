"use client"

import { useEffect, useState, type RefObject } from "react"

const HIDE_DELAY = 3000

export function useFullscreenControls(frame: RefObject<HTMLDivElement | null>) {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (!frame.current) return
    const element: HTMLDivElement = frame.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let pointerDown = false

    function schedule() {
      clearTimeout(timer)
      if (document.fullscreenElement !== element) return
      timer = setTimeout(() => {
        if (
          pointerDown ||
          element.querySelector(
            '[data-slot="popover-content"][data-open], [role="dialog"]'
          ) ||
          element.querySelector(".fullscreen-controls :focus-visible")
        ) {
          schedule()
          return
        }
        setHidden(true)
      }, HIDE_DELAY)
    }

    function activity() {
      setHidden(false)
      schedule()
    }
    function down() {
      pointerDown = true
      activity()
    }
    function up() {
      pointerDown = false
      schedule()
    }
    function fullscreenChange() {
      pointerDown = false
      activity()
    }

    document.addEventListener("fullscreenchange", fullscreenChange)
    element.addEventListener("pointermove", activity)
    element.addEventListener("pointerdown", down)
    element.addEventListener("keydown", activity)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("fullscreenchange", fullscreenChange)
      element.removeEventListener("pointermove", activity)
      element.removeEventListener("pointerdown", down)
      element.removeEventListener("keydown", activity)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
  }, [frame])

  return hidden
}
