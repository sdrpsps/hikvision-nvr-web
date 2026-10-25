"use client"

import { useState, type RefObject } from "react"
import { EllipsisIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useFullscreenContainer } from "@/hooks/use-fullscreen-container"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"

export function RestartAction({
  container,
  label,
  onRestart,
}: {
  container?: RefObject<HTMLDivElement | null>
  label: string
  onRestart: () => void
}) {
  const [open, setOpen] = useState(false)
  const portalContainer = useFullscreenContainer(container)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="更多播放操作"
            title="更多播放操作"
          />
        }
      >
        <EllipsisIcon />
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        side="top"
        align="end"
        className="w-40"
      >
        <PopoverTitle className="sr-only">播放操作</PopoverTitle>
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            setOpen(false)
            onRestart()
          }}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {label}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
