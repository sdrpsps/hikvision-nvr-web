"use client"

import type { ReactNode } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { VideoWall, type WallLayout } from "@/components/video-wall"

const layoutVariables: Record<WallLayout, string> = {
  1: "[--wall-columns:1] [--wall-rows:1]",
  2: "[--wall-columns:2] [--wall-rows:1]",
  4: "[--wall-columns:2] [--wall-rows:2]",
  8: "[--wall-columns:4] [--wall-rows:2]",
  16: "[--wall-columns:4] [--wall-rows:4]",
}

const fitWidth =
  "[--height-fit-width:calc(((100cqh_-_(var(--wall-rows)_-_1)_*_var(--wall-gap))_/_var(--wall-rows)_-_var(--window-chrome))_*_16_/_9_+_var(--window-inset))] " +
  "[--wall-fit-width:calc(var(--wall-columns)_*_var(--height-fit-width)_+_(var(--wall-columns)_-_1)_*_var(--wall-gap))] " +
  "[--wall-min-width:calc(var(--wall-columns)_*_9rem_+_(var(--wall-columns)_-_1)_*_var(--wall-gap))] " +
  "w-[min(100cqw,max(var(--wall-min-width),var(--wall-fit-width)))]"

export function LiveVideoWall({
  layout,
  renderWindow,
}: {
  layout: WallLayout
  renderWindow: (index: number) => ReactNode
}) {
  return (
    <ScrollArea
      className="min-h-0 min-w-0 flex-1 [--wall-gap:8px] max-md:flex-none"
      scrollbars="both"
      viewportProps={{
        className:
          "live-wall-viewport min-h-0 min-w-0 p-0.5 [container-type:size] max-md:h-auto max-md:[container-type:inline-size]",
        "data-layout": layout,
      }}
      contentProps={{
        className:
          "grid min-h-full [&_.video-wall]:[gap:var(--wall-gap)] max-md:min-h-0",
      }}
    >
      <div
        className={`mx-auto ${layoutVariables[layout]} ${fitWidth} max-md:m-0 max-md:w-full`}
      >
        <VideoWall
          count={layout}
          label="实时预览窗口"
          renderWindow={renderWindow}
        />
      </div>
    </ScrollArea>
  )
}
