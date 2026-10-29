"use client"

import { MonitorIcon } from "lucide-react"
import { useLiveConsole } from "@/hooks/use-live-console"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ConsoleNav } from "@/components/console-nav"
import { ChannelSidebar } from "@/components/channel-sidebar"
import { SaveActivityBar } from "@/components/browser-save-provider"
import { VideoWall } from "@/components/video-wall"
import { LiveToolbar } from "@/components/live/toolbar"
import { LiveWindow } from "@/components/live/window"

export function LiveConsole() {
  const state = useLiveConsole()
  const {
    layout,
    sidebarOpen,
    channels,
    error,
    selected,
    trackFor,
    setAssignments,
    refreshChannels,
  } = state

  return (
    <div className="console-shell live-shell">
      <header className="console-header">
        <div className="console-brand">
          <div className="brand-mark">
            <MonitorIcon aria-hidden="true" />
          </div>
          <span>NVR 控制台</span>
        </div>
        <ConsoleNav active="live" />
      </header>
      <SaveActivityBar />
      <main className="console-main live-main">
        <h1 className="sr-only">实时预览</h1>
        <LiveToolbar {...state} />
        {!sidebarOpen && error && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂时无法显示通道</EmptyTitle>
            </EmptyHeader>
            <Button variant="outline" onClick={refreshChannels}>
              重新读取
            </Button>
          </Empty>
        )}
        <div
          className={cn(
            "channel-workspace live-workspace",
            !sidebarOpen && "is-sidebar-collapsed"
          )}
        >
          <ChannelSidebar
            id="live-channels"
            open={sidebarOpen}
            channels={channels}
            error={error}
            selectedTrack={trackFor(selected)}
            onSelect={(track) =>
              setAssignments((old) => ({ ...old, [selected]: track }))
            }
            onRefresh={refreshChannels}
            allowRename
          />
          <section className="live-stage" aria-label="多窗口实时预览">
            <ScrollArea
              className="live-wall-scroll"
              scrollbars="both"
              viewportProps={{
                className: "live-wall-viewport",
                "data-layout": layout,
              }}
              contentProps={{ className: "live-wall-content" }}
            >
              <VideoWall
                count={layout}
                label="实时预览窗口"
                renderWindow={(index) => (
                  <LiveWindow {...state} index={index} />
                )}
              />
            </ScrollArea>
          </section>
        </div>
      </main>
    </div>
  )
}
