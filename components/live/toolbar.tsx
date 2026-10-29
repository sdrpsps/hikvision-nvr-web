"use client"

import { PlayIcon, SquareIcon } from "lucide-react"
import { ChannelSidebarToggle } from "@/components/channel-sidebar"
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
        <ChannelSidebarToggle
          open={sidebarOpen}
          controls="live-channels"
          onToggle={toggleSidebar}
        />
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
