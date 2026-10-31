"use client"

import { ConsoleHeader } from "@/components/console/header"
import { SaveActivityBar } from "@/components/browser-save-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { RecordingLoading } from "@/components/recording/loading"
import { LiveVideoWall } from "@/components/live/wall"
import { cn } from "@/lib/utils"

export function ConsoleLoading({ mode }: { mode: "live" | "playback" }) {
  const live = mode === "live"
  const title = live ? "实时预览" : "录像回放"

  return (
    <div
      className={cn(
        "flex h-dvh min-h-128 flex-col [font-optical-sizing:auto]",
        "max-md:h-auto max-md:min-h-dvh"
      )}
    >
      <ConsoleHeader active={mode} />
      <SaveActivityBar />
      <main
        className={cn(
          "mx-auto flex min-h-0 w-full max-w-[100rem] flex-1 flex-col px-6 pt-4 pb-6 max-[1100px]:px-4 max-md:p-3"
        )}
        aria-busy="true"
        aria-label={title}
      >
        <h1 className="sr-only">{title}</h1>
        <p role="status" className="sr-only">
          正在加载{title}…
        </p>
        <div
          className="mb-3.5 flex flex-wrap items-center gap-3"
          aria-hidden="true"
        >
          <Skeleton className="h-9 w-20" />
          <Skeleton className={live ? "h-9 w-56 max-w-[45%]" : "h-9 w-40"} />
          <Skeleton className="ml-auto h-9 w-20" />
        </div>
        <div
          className={cn(
            "grid min-h-96 flex-1 [grid-template-columns:var(--channel-sidebar-width)_minmax(0,1fr)] overflow-hidden rounded-lg border bg-card [--channel-sidebar-width:12rem] max-[1100px]:[--channel-sidebar-width:10.5rem] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]"
          )}
          aria-hidden="true"
        >
          <div className="flex flex-col gap-2 border-r p-4 max-md:grid max-md:grid-cols-2 max-md:border-r-0 max-md:border-b [&>:first-child]:max-md:col-span-2 [&>:nth-child(n+4)]:max-md:hidden">
            <Skeleton className="mb-3 h-5 w-20" />
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
          {live ? (
            <div className="flex min-h-0 min-w-0 flex-col bg-background p-2 [--window-chrome:calc(var(--window-heading-height)+2px)] [--window-heading-height:2.125rem] [--window-inset:2px] max-md:p-1.5">
              <LiveVideoWall
                layout={4}
                renderWindow={() => (
                  <div className="@container relative flex w-full min-w-0 flex-col overflow-hidden rounded-sm border bg-card">
                    <div className="flex h-[var(--window-heading-height,2.125rem)] shrink-0 items-center gap-1 px-1.5 py-0.5">
                      <Skeleton className="h-5 w-24" />
                    </div>
                    <Skeleton className="aspect-video w-full rounded-none" />
                  </div>
                )}
              />
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-4 p-4 max-md:p-2">
              <RecordingLoading />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
