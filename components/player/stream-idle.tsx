"use client"

import { LoaderCircleIcon, PlayIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"

type IdleProps = {
  track: string
  live: boolean
  loading: boolean
  error: string
  expired: boolean
  prepare: () => Promise<void>
}

export function StreamIdle({
  track,
  live,
  loading,
  error,
  expired,
  prepare,
}: IdleProps) {
  const startLabel = error || expired ? "重试" : live ? "开始预览" : "播放"
  return (
    <Empty className="stream-idle" aria-busy={loading}>
      {!loading && (
        <Button
          className="playback-center-button"
          size="icon-lg"
          disabled={!track}
          aria-label={startLabel}
          title={startLabel}
          onClick={() => void prepare()}
        >
          {error || expired ? <RefreshCwIcon /> : <PlayIcon />}
        </Button>
      )}
      {(loading || error || expired) && (
        <EmptyHeader>
          {loading && (
            <LoaderCircleIcon
              className="player-loading-icon animate-spin"
              aria-hidden="true"
            />
          )}
          <EmptyTitle role={loading ? "status" : undefined}>
            {loading ? (live ? "正在连接通道" : "正在准备录像") : "预览未完成"}
          </EmptyTitle>
          {expired && (
            <EmptyDescription>本次连接已到期，请重试。</EmptyDescription>
          )}
          {error && <EmptyDescription role="alert">{error}</EmptyDescription>}
        </EmptyHeader>
      )}
    </Empty>
  )
}
