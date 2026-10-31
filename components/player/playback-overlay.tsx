"use client"

import { LoaderCircleIcon, PlayIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"

type OverlayProps = {
  live: boolean
  liveStarted: boolean
  historyLoading: boolean
  pendingSeek: number | null
  paused: boolean
  togglePlayback: () => void
}

export function PlaybackOverlay({
  live,
  liveStarted,
  historyLoading,
  pendingSeek,
  paused,
  togglePlayback,
}: OverlayProps) {
  return (
    <>
      {!live && !historyLoading && (
        <Button
          className="playback-surface-button absolute inset-0 size-full rounded-none border-0 bg-transparent p-0 hover:bg-transparent active:translate-none"
          variant="ghost"
          aria-label={paused ? "播放录像" : "暂停录像"}
          title={paused ? "播放录像" : "暂停录像"}
          onClick={togglePlayback}
        >
          {paused && (
            <span
              className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground [&>svg]:size-6"
              aria-hidden="true"
            >
              <PlayIcon />
            </span>
          )}
        </Button>
      )}
      {live && !liveStarted && (
        <Empty
          className="live-startup pointer-events-none absolute inset-0 rounded-none bg-muted p-2"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <EmptyHeader>
            <LoaderCircleIcon
              className="mx-auto size-7 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
            <EmptyTitle>正在缓冲画面</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {!live && historyLoading && (
        <Empty
          className="playback-startup pointer-events-none absolute inset-0 rounded-none bg-muted p-2"
          role="status"
        >
          <EmptyHeader>
            <LoaderCircleIcon
              className="mx-auto size-7 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
            <EmptyTitle>
              {pendingSeek !== null ? "正在定位所选时间" : "正在缓冲录像"}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </>
  )
}
