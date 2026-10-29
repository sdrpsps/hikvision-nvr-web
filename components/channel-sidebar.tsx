"use client"

import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  VideoIcon,
} from "lucide-react"
import type { Channel } from "@/shared/contracts"
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

type ChannelSidebarProps = {
  id: string
  open?: boolean
  channels?: Channel[]
  error?: string
  selectedTrack: string
  onSelect: (track: string) => void
  onRefresh: () => void
  allowRename?: boolean
}

export function ChannelSidebarToggle({
  open,
  controls,
  onToggle,
}: {
  open: boolean
  controls: string
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={open ? "收起通道" : "展开通道"}
      aria-expanded={open}
      aria-controls={controls}
      onClick={(event) => {
        event.currentTarget.focus()
        onToggle()
      }}
    >
      {open ? (
        <PanelLeftCloseIcon data-icon="inline-start" />
      ) : (
        <PanelLeftOpenIcon data-icon="inline-start" />
      )}
      通道
    </Button>
  )
}

export function ChannelSidebar({
  id,
  open = true,
  channels,
  error,
  selectedTrack,
  onSelect,
  onRefresh,
  allowRename = false,
}: ChannelSidebarProps) {
  return (
    <aside
      id={id}
      className="channel-sidebar"
      aria-label="设备通道"
      aria-hidden={!open}
      inert={!open}
    >
      <ScrollArea
        className="channel-sidebar-scroll"
        viewportProps={{ className: "channel-sidebar-viewport" }}
        contentProps={{ className: "channel-sidebar-content" }}
      >
        <div className="channel-heading">
          <h2>设备通道</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="刷新通道"
            onClick={onRefresh}
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
          className="channel-list-scroll"
          viewportProps={{ className: "channel-list-viewport" }}
        >
          <ul className="channel-list">
            {channels?.map((channel) => (
              <li key={channel.id} className="flex items-center gap-1">
                <Button
                  type="button"
                  variant={selectedTrack === channel.id ? "secondary" : "ghost"}
                  className="h-auto min-w-0 flex-1 justify-start py-2.5"
                  title={`通道 ${channel.id}`}
                  aria-pressed={selectedTrack === channel.id}
                  onClick={() => onSelect(channel.id)}
                >
                  <VideoIcon data-icon="inline-start" aria-hidden="true" />
                  <span className="truncate">{channel.name}</span>
                </Button>
                {allowRename && <RenameChannel channel={channel} />}
              </li>
            ))}
          </ul>
        </ScrollArea>
      </ScrollArea>
    </aside>
  )
}
