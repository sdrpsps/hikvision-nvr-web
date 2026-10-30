"use client"

import { ConsoleHeader } from "@/components/console/header"
import { SaveActivityBar } from "@/components/browser-save-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RecordingLoading } from "@/components/recording/loading"
import { VideoWall } from "@/components/video-wall"
import { cn } from "@/lib/utils"

export function ConsoleLoading({ mode }: { mode: "live" | "playback" }) {
  const live = mode === "live"
  const title = live ? "实时预览" : "录像回放"

  return (
    <div
      className={cn("console-shell", live ? "live-shell" : "playback-shell")}
    >
      <ConsoleHeader active={mode} />
      <SaveActivityBar />
      <main
        className={cn(
          "console-main console-loading",
          live ? "live-main" : "playback-main"
        )}
        aria-busy="true"
        aria-label={title}
      >
        <h1 className="sr-only">{title}</h1>
        <p role="status" className="sr-only">
          正在加载{title}…
        </p>
        <div className="console-loading-toolbar" aria-hidden="true">
          <Skeleton className="h-9 w-20" />
          <Skeleton className={live ? "h-9 w-56 max-w-[45%]" : "h-9 w-40"} />
          <Skeleton className="ml-auto h-9 w-20" />
        </div>
        <div
          className={cn(
            "channel-workspace console-loading-workspace",
            live ? "live-workspace" : "playback-workspace"
          )}
          aria-hidden="true"
        >
          <div className="console-loading-sidebar">
            <Skeleton className="mb-3 h-5 w-20" />
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
          {live ? (
            <div className="live-stage">
              <ScrollArea
                className="live-wall-scroll"
                scrollbars="both"
                viewportProps={{
                  className: "live-wall-viewport",
                  "data-layout": 4,
                }}
                contentProps={{ className: "live-wall-content" }}
              >
                <VideoWall
                  count={4}
                  renderWindow={() => (
                    <div className="live-window">
                      <div className="window-heading">
                        <Skeleton className="h-5 w-24" />
                      </div>
                      <Skeleton className="console-loading-picture" />
                    </div>
                  )}
                />
              </ScrollArea>
            </div>
          ) : (
            <div className="recording-content">
              <RecordingLoading />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
