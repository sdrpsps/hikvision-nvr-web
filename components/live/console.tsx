"use client"

import { useLiveConsole } from "@/hooks/use-live-console"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ConsoleHeader } from "@/components/console/header"
import { ChannelSidebar } from "@/components/channel-sidebar"
import { SaveActivityBar } from "@/components/browser-save-provider"
import { LiveToolbar } from "@/components/live/toolbar"
import { LiveWindow } from "@/components/live/window"
import { LiveVideoWall } from "@/components/live/wall"

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
    <div className="flex h-dvh min-h-128 flex-col [font-optical-sizing:auto] max-md:h-auto max-md:min-h-dvh">
      <ConsoleHeader active="live" />
      <SaveActivityBar />
      <main className="mx-auto flex min-h-0 w-full max-w-[100rem] flex-1 flex-col px-6 pt-4 pb-6 max-[1100px]:px-4 max-md:p-3">
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
            "channel-workspace grid min-h-0 flex-1 [grid-template-columns:var(--channel-sidebar-width)_minmax(0,1fr)] overflow-hidden rounded-lg border bg-card transition-[grid-template-columns,grid-template-rows] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] [--channel-sidebar-width:12rem] motion-reduce:transition-none max-[1100px]:[--channel-sidebar-width:10.5rem] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]",
            !sidebarOpen &&
              "max-md:grid-rows-[0fr_minmax(0,1fr)] md:grid-cols-[0_minmax(0,1fr)]"
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
          <section
            className="live-stage flex min-h-0 min-w-0 flex-col bg-background p-2 [--window-chrome:calc(var(--window-heading-height)+2px)] [--window-heading-height:2.125rem] [--window-inset:2px] max-md:p-1.5"
            aria-label="多窗口实时预览"
          >
            <LiveVideoWall
              layout={layout}
              renderWindow={(index) => <LiveWindow {...state} index={index} />}
            />
          </section>
        </div>
      </main>
    </div>
  )
}
