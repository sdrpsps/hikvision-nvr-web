"use client"

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"

import { ScrollArea } from "@/components/ui/scroll-area"

export function ConsoleScrollArea({ children }: { children: React.ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  useEffect(() => {
    viewport.current?.scrollTo({ top: 0, left: 0 })
  }, [pathname])

  return (
    <ScrollArea
      className="app-scroll-area h-dvh w-full"
      viewportProps={{
        ref: viewport,
        className: "app-scroll-viewport overflow-x-hidden!",
        "aria-label": "页面内容",
      }}
    >
      {children}
    </ScrollArea>
  )
}
