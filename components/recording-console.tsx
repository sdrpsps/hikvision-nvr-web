"use client"

import { MonitorIcon } from "lucide-react"
import { useRecordingConsole } from "@/hooks/use-recording-console"
import { cn } from "@/lib/utils"
import { ConsoleNav } from "@/components/console-nav"
import { ChannelSidebar } from "@/components/channel-sidebar"
import { SaveActivityBar } from "@/components/browser-save-provider"
import { RecordingQueryBar } from "@/components/recording/query-bar"
import { RecordingResults } from "@/components/recording/results"

export function RecordingConsole() {
  const state = useRecordingConsole()

  return (
    <div className="console-shell playback-shell">
      <header className="console-header">
        <div className="console-brand">
          <div className="brand-mark">
            <MonitorIcon aria-hidden="true" />
          </div>
          <span>NVR 控制台</span>
        </div>
        <ConsoleNav active="playback" />
      </header>
      <SaveActivityBar />
      <main className="console-main playback-main">
        <h1 className="sr-only">录像回放</h1>
        <RecordingQueryBar {...state} />
        <div
          className={cn(
            "channel-workspace playback-workspace",
            !state.sidebarOpen && "is-sidebar-collapsed"
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
          />
          <RecordingResults state={state} />
        </div>
      </main>
    </div>
  )
}
