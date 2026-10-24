"use client"

import { useEffect, useState, type RefObject } from "react"

export function useFullscreenContainer(
  container?: RefObject<HTMLDivElement | null>
) {
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const update = () => {
      setFullscreen(
        !!container?.current && document.fullscreenElement === container.current
      )
    }
    update()
    document.addEventListener("fullscreenchange", update)
    return () => document.removeEventListener("fullscreenchange", update)
  }, [container])
  return fullscreen ? container : undefined
}
