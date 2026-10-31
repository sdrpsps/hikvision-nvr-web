"use client"

import { useRecordingConsole } from "@/hooks/use-recording-console"
import { cn } from "@/lib/utils"
import { ConsoleHeader } from "@/components/console/header"
import { ChannelSidebar } from "@/components/channel-sidebar"
import { SaveActivityBar } from "@/components/browser-save-provider"
import { RecordingQueryBar } from "@/components/recording/query-bar"
import { RecordingResults } from "@/components/recording/results"

export function RecordingConsole() {
  const state = useRecordingConsole()

  return (
    <div className="flex min-h-[max(32rem,100dvh)] flex-col [font-optical-sizing:auto] max-md:min-h-dvh">
      <ConsoleHeader active="playback" />
      <SaveActivityBar />
      <main className="mx-auto flex min-h-0 w-full max-w-[100rem] flex-1 flex-col px-6 pt-4 pb-6 max-[1100px]:px-4 max-md:p-3">
        <h1 className="sr-only">录像回放</h1>
        <RecordingQueryBar {...state} />
        <div
          className={cn(
            "channel-workspace grid min-h-0 flex-1 [grid-template-columns:var(--channel-sidebar-width)_minmax(0,1fr)] overflow-hidden rounded-lg border bg-card transition-[grid-template-columns,grid-template-rows] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] [--channel-sidebar-width:12rem] motion-reduce:transition-none max-[1100px]:[--channel-sidebar-width:10.5rem] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]",
            !state.sidebarOpen &&
              "max-md:grid-rows-[0fr_minmax(0,1fr)] md:grid-cols-[0_minmax(0,1fr)]"
          )}
        >
          <ChannelSidebar
            id="playback-channels"
            open={state.sidebarOpen}
            channels={state.resources?.channels}
            error={state.resourceError}
            selectedTrack={state.track}
            onSelect={state.setTrack}
            onRefresh={state.refreshChannels}
            playback
          />
          <RecordingResults state={state} />
        </div>
      </main>
    </div>
  )
}
