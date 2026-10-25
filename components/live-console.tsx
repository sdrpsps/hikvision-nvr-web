"use client"

import { useCallback, useRef, useState } from "react"
import { useQueryErrorToast } from "@/hooks/use-query-error-toast"
import {
  MonitorIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  VideoIcon,
} from "lucide-react"
import { useChannels } from "@/hooks/use-api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { ConsoleNav } from "@/components/console-nav"
import {
  LiveRecordButton,
  SaveActivityBar,
} from "@/components/browser-save-provider"
import {
  StreamPlayer,
  type StreamPlayerHandle,
} from "@/components/preview-player"
import {
  VideoWall,
  WallLayoutControl,
  type WallLayout,
} from "@/components/video-wall"

export function LiveConsole() {
  const [layout, setLayout] = useState<WallLayout>(4)
  const [selected, setSelected] = useState(0)
  const [assignments, setAssignments] = useState<Record<number, string>>({})
  const channelsQuery = useChannels()
  const channels = channelsQuery.data?.channels
  const error = channelsQuery.error?.message
  useQueryErrorToast(channelsQuery, "通道读取失败")
  const [generation, setGeneration] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [activity, setActivity] = useState<Record<number, boolean>>({})
  const players = useRef(new Map<number, StreamPlayerHandle>())
  const updateActivity = useCallback((index: number, active: boolean) => {
    setActivity((old) =>
      old[index] === active ? old : { ...old, [index]: active }
    )
  }, [])
  const trackFor = (index: number) => {
    const id = assignments[index] ?? channels?.[index]?.id ?? ""
    return channels?.some((channel) => channel.id === id) ? id : ""
  }
  return (
    <div className="console-shell live-shell">
      <header className="console-header">
        <div className="console-brand">
          <div className="brand-mark">
            <MonitorIcon aria-hidden="true" />
          </div>
          <span>NVR 控制台</span>
        </div>
        <ConsoleNav active="live" />
      </header>
      <SaveActivityBar />
      <main className="console-main live-main">
        <h1 className="sr-only">实时预览</h1>
        <div className="console-toolbar">
          <div className="console-toolbar-group">
            <Button
              variant="ghost"
              aria-label={sidebarOpen ? "收起通道" : "展开通道"}
              aria-expanded={sidebarOpen}
              aria-controls="live-channels"
              onClick={(event) => {
                event.currentTarget.focus()
                setSidebarOpen((open) => !open)
              }}
            >
              {sidebarOpen ? (
                <PanelLeftCloseIcon data-icon="inline-start" />
              ) : (
                <PanelLeftOpenIcon data-icon="inline-start" />
              )}
              通道
            </Button>
            <span className="channel-target">分配到窗口 {selected + 1}</span>
          </div>
          <div className="console-toolbar-group live-toolbar-actions">
            <WallLayoutControl
              value={layout}
              onChange={(value) => {
                setLayout(value)
                setSelected((old) => Math.min(old, value - 1))
              }}
            />
            <Button
              disabled={
                !Array.from({ length: layout }, (_, index) =>
                  trackFor(index)
                ).some(Boolean)
              }
              onClick={() => {
                for (const player of players.current.values()) player.start()
              }}
            >
              <PlayIcon data-icon="inline-start" />
              全部开始
            </Button>
            <Button
              variant="outline"
              disabled={
                !Array.from(
                  { length: layout },
                  (_, index) => activity[index]
                ).some(Boolean)
              }
              onClick={() => setGeneration((value) => value + 1)}
            >
              <SquareIcon data-icon="inline-start" />
              停止全部预览
            </Button>
          </div>
        </div>
        {!sidebarOpen && error && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂时无法显示通道</EmptyTitle>
            </EmptyHeader>
            <Button
              variant="outline"
              onClick={() => void channelsQuery.refetch()}
            >
              重新读取
            </Button>
          </Empty>
        )}
        <div
          className={cn(
            "live-workspace",
            !sidebarOpen && "is-sidebar-collapsed"
          )}
        >
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
                  onClick={() => void channelsQuery.refetch()}
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
                    <li key={channel.id}>
                      <Button
                        type="button"
                        variant={
                          trackFor(selected) === channel.id
                            ? "secondary"
                            : "ghost"
                        }
                        className="h-auto w-full justify-start py-2.5"
                        title={`通道 ${channel.id}`}
                        aria-pressed={trackFor(selected) === channel.id}
                        onClick={() =>
                          setAssignments((old) => ({
                            ...old,
                            [selected]: channel.id,
                          }))
                        }
                      >
                        <VideoIcon
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        <span className="truncate">{channel.name}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </ScrollArea>
          </aside>
          <section className="live-stage" aria-label="多窗口实时预览">
            <ScrollArea
              className="live-wall-scroll"
              scrollbars="both"
              viewportProps={{
                className: "live-wall-viewport",
                "data-layout": layout,
              }}
              contentProps={{ className: "live-wall-content" }}
            >
              <VideoWall
                count={layout}
                label="实时预览窗口"
                renderWindow={(index) => (
                  <section
                    className={cn(
                      "live-window",
                      selected === index && "is-selected"
                    )}
                    aria-label={`窗口 ${index + 1}`}
                    onFocusCapture={() => setSelected(index)}
                    onPointerDown={() => setSelected(index)}
                  >
                    <div className="window-heading live-window-heading">
                      <Button
                        className="window-selector"
                        type="button"
                        size="xs"
                        variant="ghost"
                        aria-label={`选择窗口 ${index + 1}`}
                        aria-pressed={selected === index}
                        onClick={() => setSelected(index)}
                      >
                        {index + 1}
                      </Button>
                      <Select
                        items={[
                          { label: "选择通道", value: "" },
                          ...(channels?.map((channel) => ({
                            label: channel.name,
                            value: channel.id,
                          })) ?? []),
                        ]}
                        value={trackFor(index)}
                        disabled={!channels?.length}
                        onValueChange={(value) =>
                          setAssignments((old) => ({
                            ...old,
                            [index]: value ?? "",
                          }))
                        }
                      >
                        <SelectTrigger
                          className="window-channel"
                          size="sm"
                          aria-label={`窗口 ${index + 1} 通道`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent alignItemWithTrigger={false}>
                          <SelectGroup>
                            <SelectItem value="">选择通道</SelectItem>
                            {channels?.map((channel) => (
                              <SelectItem key={channel.id} value={channel.id}>
                                {channel.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <LiveRecordButton
                        track={trackFor(index)}
                        timeZone={channelsQuery.data?.timeZone}
                        name={
                          channels?.find(
                            (channel) => channel.id === trackFor(index)
                          )?.name ?? "摄像头"
                        }
                      />
                    </div>
                    <StreamPlayer
                      ref={(player) => {
                        if (player) players.current.set(index, player)
                        else players.current.delete(index)
                      }}
                      key={`${generation}|${trackFor(index)}`}
                      track={trackFor(index)}
                      onActivityChange={(active) =>
                        updateActivity(index, active)
                      }
                      live
                    />
                  </section>
                )}
              />
            </ScrollArea>
          </section>
        </div>
      </main>
    </div>
  )
}
