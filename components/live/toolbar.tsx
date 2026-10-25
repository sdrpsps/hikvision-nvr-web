"use client"

import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { WallLayoutControl } from "@/components/video-wall"
import type { LiveConsoleState } from "@/hooks/use-live-console"

type ToolbarProps = Pick<
  LiveConsoleState,
  | "sidebarOpen"
  | "selected"
  | "layout"
  | "activity"
  | "trackFor"
  | "toggleSidebar"
  | "setLayout"
  | "startAll"
  | "stopAll"
>

export function LiveToolbar({
  sidebarOpen,
  selected,
  layout,
  activity,
  trackFor,
  toggleSidebar,
  setLayout,
  startAll,
  stopAll,
}: ToolbarProps) {
  return (
    <div className="console-toolbar">
      <div className="console-toolbar-group">
        <Button
          variant="ghost"
          aria-label={sidebarOpen ? "收起通道" : "展开通道"}
          aria-expanded={sidebarOpen}
          aria-controls="live-channels"
          onClick={(event) => {
            event.currentTarget.focus()
            toggleSidebar()
          }}
        >
          {sidebarOpen ? (
            <PanelLeftCloseIcon data-icon="inline-start" />
          ) : (
            <PanelLeftOpenIcon data-icon="inline-start" />
          )}
          通道
        </Button>
        <span className="channel-target">分配到窗口 {selected + 1}</span>
      </div>
      <div className="console-toolbar-group live-toolbar-actions">
        <WallLayoutControl value={layout} onChange={setLayout} />
        <Button
          disabled={
            !Array.from({ length: layout }, (_, index) => trackFor(index)).some(
              Boolean
            )
          }
          onClick={startAll}
        >
          <PlayIcon data-icon="inline-start" />
          全部开始
        </Button>
        <Button
          variant="outline"
          disabled={
            !Array.from({ length: layout }, (_, index) => activity[index]).some(
              Boolean
            )
          }
          onClick={stopAll}
        >
          <SquareIcon data-icon="inline-start" />
          停止全部预览
        </Button>
      </div>
    </div>
  )
}
