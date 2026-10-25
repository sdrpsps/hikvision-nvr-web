"use client"

import { RefreshCwIcon, VideoIcon } from "lucide-react"
import type { LiveConsoleState } from "@/hooks/use-live-console"
import { RenameChannel } from "@/components/rename-channel"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"

type ChannelSidebarProps = Pick<
  LiveConsoleState,
  | "sidebarOpen"
  | "channels"
  | "error"
  | "selected"
  | "trackFor"
  | "setAssignments"
  | "refreshChannels"
>

export function LiveChannelSidebar({
  sidebarOpen,
  channels,
  error,
  selected,
  trackFor,
  setAssignments,
  refreshChannels,
}: ChannelSidebarProps) {
  return (
    <aside
      id="live-channels"
      className="live-sidebar"
      aria-label="设备通道"
      aria-hidden={!sidebarOpen}
      inert={!sidebarOpen}
    >
      <ScrollArea
        className="live-sidebar-scroll"
        viewportProps={{ className: "live-sidebar-viewport" }}
        contentProps={{ className: "live-sidebar-content" }}
      >
        <div className="channel-heading">
          <h2>设备通道</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="刷新通道"
            onClick={refreshChannels}
          >
            <RefreshCwIcon />
          </Button>
        </div>
        {!channels && !error && (
          <div
            role="status"
            aria-label="正在读取通道"
            className="flex flex-col gap-3"
          >
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}
        {error && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂时无法显示通道</EmptyTitle>
              <EmptyDescription>请刷新通道后重试。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {channels?.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无通道</EmptyTitle>
              <EmptyDescription>
                设备未返回通道，请检查连接和查询权限后刷新。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <ScrollArea
          className="live-channel-scroll"
          viewportProps={{ className: "live-channel-viewport" }}
        >
          <ul className="channel-list">
            {channels?.map((channel) => (
              <li key={channel.id} className="flex items-center gap-1">
                <Button
                  type="button"
                  variant={
                    trackFor(selected) === channel.id ? "secondary" : "ghost"
                  }
                  className="h-auto min-w-0 flex-1 justify-start py-2.5"
                  title={`通道 ${channel.id}`}
                  aria-pressed={trackFor(selected) === channel.id}
                  onClick={() =>
                    setAssignments((old) => ({
                      ...old,
                      [selected]: channel.id,
                    }))
                  }
                >
                  <VideoIcon data-icon="inline-start" aria-hidden="true" />
                  <span className="truncate">{channel.name}</span>
                </Button>
                <RenameChannel channel={channel} />
              </li>
            ))}
          </ul>
        </ScrollArea>
      </ScrollArea>
    </aside>
  )
}
