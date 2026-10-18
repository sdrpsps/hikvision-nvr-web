"use client"

import type { ReactNode } from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export const WALL_LAYOUTS = [1, 2, 4, 8, 16] as const
export type WallLayout = (typeof WALL_LAYOUTS)[number]

export function WallLayoutControl({
  value,
  onChange,
}: {
  value: WallLayout
  onChange: (value: WallLayout) => void
}) {
  return (
    <ToggleGroup
      aria-label="预览分屏"
      value={[String(value)]}
      onValueChange={(values) => {
        const next = Number(values[0])
        if (WALL_LAYOUTS.some((layout) => layout === next))
          onChange(next as WallLayout)
      }}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {WALL_LAYOUTS.map((layout) => (
        <ToggleGroupItem
          key={layout}
          value={String(layout)}
          aria-label={`${layout} 路`}
        >
          {layout} 路
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

// Layout only: live and playback own their sources and session lifecycles.
export function VideoWall({
  count,
  renderWindow,
  label = "视频窗口",
}: {
  count: WallLayout
  renderWindow: (index: number) => ReactNode
  label?: string
}) {
  return (
    <div
      className="video-wall"
      data-layout={count}
      role="group"
      aria-label={label}
    >
      {Array.from({ length: count }, (_, index) => (
        <div className="video-wall-cell" key={index}>
          {renderWindow(index)}
        </div>
      ))}
    </div>
  )
}
