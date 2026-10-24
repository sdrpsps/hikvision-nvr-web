"use client"

import { useEffect, useRef, useState } from "react"
import {
  MonitorIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  VideoIcon,
} from "lucide-react"
import { channelsSchema, type Channel } from "@/shared/contracts"
import { getJson } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { ConsoleNav } from "@/components/console-nav"
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
  const [channels, setChannels] = useState<Channel[]>()
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [generation, setGeneration] = useState(0)
  const players = useRef(new Map<number, StreamPlayerHandle>())
  useEffect(() => {
    const controller = new AbortController()
    getJson("/api/channels", channelsSchema, controller.signal)
      .then((data) => {
        setChannels(data.channels)
        setError("")
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message)
      })
    return () => controller.abort()
  }, [refresh])
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
        <Badge variant="outline">手动开启画面</Badge>
      </header>
      <main className="console-main live-main">
        <div className="page-heading">
          <div>
            <h1>实时预览</h1>
            <p>先选窗口，再选通道。点击开始预览后连接画面。</p>
          </div>
          <div className="flex flex-wrap gap-2">
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
              onClick={() => setGeneration((value) => value + 1)}
            >
              <SquareIcon data-icon="inline-start" />
              全部停止
            </Button>
          </div>
        </div>
        <div className="live-workspace">
          <aside className="live-sidebar" aria-label="设备通道">
            <div className="channel-heading">
              <h2>设备通道</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="刷新通道"
                onClick={() => setRefresh((value) => value + 1)}
              >
                <RefreshCwIcon />
              </Button>
            </div>
            <p className="channel-hint">分配到窗口 {selected + 1}</p>
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
              <Alert variant="destructive">
                <AlertTitle>通道读取失败</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
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
            <ul className="channel-list">
              {channels?.map((channel) => (
                <li key={channel.id}>
                  <Button
                    type="button"
                    variant={
                      trackFor(selected) === channel.id ? "secondary" : "ghost"
                    }
                    className="h-auto w-full justify-start py-2.5"
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
                    <span className="channel-id">{channel.id}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </aside>
          <section className="live-stage" aria-label="多窗口实时预览">
            <div className="wall-toolbar">
              <span>{layout} 路布局</span>
              <WallLayoutControl
                value={layout}
                onChange={(value) => {
                  setLayout(value)
                  setSelected((old) => Math.min(old, value - 1))
                }}
              />
            </div>
            <div className="live-wall-viewport" data-layout={layout}>
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
                    <div className="window-heading">
                      <Button
                        className="window-selector"
                        type="button"
                        size="xs"
                        variant={selected === index ? "secondary" : "ghost"}
                        aria-label={`选择窗口 ${index + 1}`}
                        aria-pressed={selected === index}
                        onClick={() => setSelected(index)}
                      >
                        窗口 {index + 1}
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
                    </div>
                    <StreamPlayer
                      ref={(player) => {
                        if (player) players.current.set(index, player)
                        else players.current.delete(index)
                      }}
                      key={`${generation}|${trackFor(index)}`}
                      track={trackFor(index)}
                      live
                    />
                  </section>
                )}
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
