"use client"

import { LoaderCircleIcon, PauseIcon, PlayIcon } from "lucide-react"
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
          className="playback-surface-button"
          variant="ghost"
          data-paused={paused}
          aria-label={paused ? "播放录像" : "暂停录像"}
          title={paused ? "播放录像" : "暂停录像"}
          onClick={togglePlayback}
        >
          <span className="playback-center-icon" aria-hidden="true">
            {paused ? <PlayIcon /> : <PauseIcon />}
          </span>
        </Button>
      )}
      {live && !liveStarted && (
        <Empty
          className="live-startup"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <EmptyHeader>
            <LoaderCircleIcon
              className="player-loading-icon animate-spin"
              aria-hidden="true"
            />
            <EmptyTitle>正在缓冲画面</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {!live && historyLoading && (
        <Empty className="playback-startup" role="status">
          <EmptyHeader>
            <LoaderCircleIcon
              className="player-loading-icon animate-spin"
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
