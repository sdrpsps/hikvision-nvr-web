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
    <Empty
      className="stream-idle [container-type:size] relative aspect-video min-h-0 w-full flex-none bg-muted p-2"
      aria-busy={loading}
    >
      {!loading && (
        <Button
          className="absolute top-1/2 left-1/2 size-14 -translate-1/2 rounded-full [&>svg]:size-6"
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
        <EmptyHeader
          className={
            !loading
              ? "absolute top-[calc(50%+2.25rem)] max-w-[calc(100%-1rem)] gap-1.5"
              : "gap-1.5"
          }
        >
          {loading && (
            <LoaderCircleIcon
              className="mx-auto size-7 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <EmptyTitle
            className="text-[0.8125rem]"
            role={loading ? "status" : undefined}
          >
            {loading ? (live ? "正在连接通道" : "正在准备录像") : "预览未完成"}
          </EmptyTitle>
          {expired && (
            <EmptyDescription className="text-xs">
              本次连接已到期，请重试。
            </EmptyDescription>
          )}
          {error && (
            <EmptyDescription className="text-xs" role="alert">
              {error}
            </EmptyDescription>
          )}
        </EmptyHeader>
      )}
    </Empty>
  )
}
