"use client"

import { useEffect, useState } from "react"
import {
  ArchiveIcon,
  CircleAlertIcon,
  ClockIcon,
  RefreshCwIcon,
  VideoIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  channelsSchema,
  dateSchema,
  deviceSchema,
  recordingsSchema,
  type Channel,
  type Recordings,
} from "@/shared/contracts"
import { getJson } from "@/lib/api"
import { cn } from "@/lib/utils"
import { PreviewPlayer } from "@/components/preview-player"
import { ConsoleNav } from "@/components/console-nav"

function clock(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso))
}
function duration(ms: number) {
  const seconds = Math.round(ms / 1000)
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60)
  return hours
    ? `${hours} 小时 ${minutes} 分`
    : minutes
      ? `${minutes} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`
}
type Resource = { channels: Channel[]; timeZone: string; today: string }
type QueryResult = { key: string; data?: Recordings; error?: string }

export function RecordingConsole() {
  const [resources, setResources] = useState<Resource>()
  const [resourceError, setResourceError] = useState("")
  const [device, setDevice] = useState<{ model: string; firmware: string }>()
  const [deviceError, setDeviceError] = useState("")
  const [track, setTrack] = useState("")
  const [date, setDate] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<QueryResult>()
  const [selected, setSelected] = useState("")
  const [zoom, setZoom] = useState("1")
  const key = `${track}|${date}|${refresh}`
  const data = result?.key === key ? result.data : undefined
  const error = result?.key === key ? result.error : undefined
  const validDate = dateSchema.safeParse(date).success
  const loading = !!resources && !!track && validDate && result?.key !== key

  useEffect(() => {
    const controller = new AbortController()
    getJson("/api/channels", channelsSchema, controller.signal)
      .then((value) => {
        setResources(value)
        setResourceError("")
        setTrack((old) =>
          value.channels.some((channel) => channel.id === old)
            ? old
            : (value.channels[0]?.id ?? "")
        )
        setDate((old) => old || value.today)
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setResourceError(error.message)
      })
    getJson("/api/device", deviceSchema, controller.signal)
      .then((value) => {
        setDevice(value)
        setDeviceError("")
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setDeviceError(error.message)
      })
    return () => controller.abort()
  }, [refresh])

  useEffect(() => {
    if (!track || !validDate) return
    const controller = new AbortController()
    getJson(
      `/api/recordings?${new URLSearchParams({ track, date })}`,
      recordingsSchema,
      controller.signal
    )
      .then((data) => {
        setResult({ key, data })
        setSelected("")
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setResult({ key, error: error.message })
      })
    return () => controller.abort()
  }, [track, date, key, validDate])

  const currentChannel = resources?.channels.find(
    (channel) => channel.id === track
  )
  const segment = data?.segments.find((segment) => segment.id === selected)
  const coverage =
    data?.coverage.reduce(
      (sum, item) => sum + Date.parse(item.endAt) - Date.parse(item.startAt),
      0
    ) ?? 0

  return (
    <div className="console-shell">
      <header className="console-header">
        <div className="console-brand">
          <div className="brand-mark">
            <ArchiveIcon aria-hidden="true" />
          </div>
          <span>录像档案</span>
          <span className="brand-divider" />
          <span className="text-sm font-normal text-muted-foreground">
            NVR 控制台
          </span>
        </div>
        <ConsoleNav active="playback" />
        <Badge variant="outline">只读查询</Badge>
      </header>
      <main className="console-main">
        <div className="page-heading">
          <div>
            <h1>一天的录像，尽在时间轴</h1>
            <p>选择录像轨道和日期，查看设备上的历史录像区间。</p>
          </div>
          <Button
            variant="outline"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCwIcon data-icon="inline-start" />
            重新查询
          </Button>
        </div>
        <div className="console-workspace">
          <aside className="query-sidebar">
            <h2>检索录像</h2>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="track">录像轨道</FieldLabel>
                <NativeSelect
                  id="track"
                  value={track}
                  onChange={(event) => setTrack(event.target.value)}
                  disabled={!resources?.channels.length}
                >
                  {!resources?.channels.length && (
                    <NativeSelectOption value="">
                      暂无可用轨道
                    </NativeSelectOption>
                  )}
                  {resources?.channels.map((channel) => (
                    <NativeSelectOption key={channel.id} value={channel.id}>
                      {channel.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field data-invalid={!!date && !validDate}>
                <FieldLabel htmlFor="date">设备日期</FieldLabel>
                <Input
                  id="date"
                  type="date"
                  value={date}
                  aria-invalid={!!date && !validDate}
                  onChange={(event) => setDate(event.target.value)}
                  disabled={!resources}
                />
              </Field>
            </FieldGroup>
            <p className="sidebar-note">
              <ClockIcon aria-hidden="true" />
              {resources?.timeZone ?? "读取设备时区中"}
            </p>
            {!!date && !validDate && (
              <p className="text-sm text-destructive" role="alert">
                请选择有效的日期。
              </p>
            )}
            <div className="device-summary">
              <VideoIcon
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <h3>录像机</h3>
              <p>
                {device?.model ??
                  (deviceError ? "设备概要读取失败" : "设备概要读取中")}
              </p>
              {device?.firmware && (
                <p className="text-xs text-muted-foreground">
                  {device.firmware}
                </p>
              )}
              {resources && <p>{resources.channels.length} 条录像轨道</p>}
              {deviceError && (
                <p className="text-xs text-destructive">{deviceError}</p>
              )}
            </div>
            <p className="sidebar-note">
              轨道配置状态不代表当天是否有录像，检索结果以设备返回为准。
            </p>
          </aside>
          <section
            className="recording-content"
            aria-label="录像查询结果"
            aria-busy={loading}
          >
            {resourceError || error ? (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertTitle>录像查询失败</AlertTitle>
                <AlertDescription>{resourceError || error}</AlertDescription>
              </Alert>
            ) : null}
            {!resources && !resourceError ? (
              <div
                className="flex flex-col gap-4"
                role="status"
                aria-label="正在读取设备"
              >
                <Skeleton className="h-8 w-56" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : null}
            {resources && !resources.channels.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>设备未返回录像轨道</EmptyTitle>
                  <EmptyDescription>
                    请检查设备连接和账号查询权限，再重新查询。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {resources && !!track && (
              <>
                <div className="result-heading">
                  <div>
                    <p>{date || "请选择日期"}</p>
                    <h2>{currentChannel?.name ?? `轨道 ${track}`}</h2>
                  </div>
                  <Badge variant="secondary">
                    {loading
                      ? "正在查询"
                      : data
                        ? `${data.segments.length} 个录像片段`
                        : "等待查询"}
                  </Badge>
                </div>
                {loading ? (
                  <div
                    className="flex flex-col gap-4"
                    role="status"
                    aria-label="正在查询录像"
                  >
                    <Skeleton className="h-36 w-full" />
                    <Skeleton className="h-24 w-full" />
                  </div>
                ) : null}
                {data && (
                  <>
                    {data.warnings.includes("FUTURE_RECORDING_TIME") && (
                      <Alert>
                        <CircleAlertIcon />
                        <AlertTitle>录像时间需要核对</AlertTitle>
                        <AlertDescription>
                          设备返回了晚于当前时间的录像时间戳。当前按接口的 UTC
                          标记显示，固件时间语义尚待验证。
                        </AlertDescription>
                      </Alert>
                    )}
                    <div className="timeline-toolbar">
                      <h3>全天时间轴</h3>
                      <div className="flex items-center gap-3">
                        <span className="timeline-legend">有录像</span>
                        <label className="sr-only" htmlFor="zoom">
                          时间轴缩放
                        </label>
                        <NativeSelect
                          id="zoom"
                          value={zoom}
                          onChange={(event) => setZoom(event.target.value)}
                        >
                          <NativeSelectOption value="1">
                            全天
                          </NativeSelectOption>
                          <NativeSelectOption value="2">
                            2 倍
                          </NativeSelectOption>
                          <NativeSelectOption value="4">
                            4 倍
                          </NativeSelectOption>
                        </NativeSelect>
                      </div>
                    </div>
                    <RecordingTimeline
                      data={data}
                      selected={selected}
                      onSelect={setSelected}
                      zoom={Number(zoom)}
                    />
                    <div className="coverage-summary">
                      <span>
                        录像覆盖 <strong>{duration(coverage)}</strong>
                      </span>
                      <span>
                        未覆盖区间 <strong>{data.gaps.length} 个</strong>
                      </span>
                    </div>
                    <Alert>
                      <CircleAlertIcon />
                      <AlertTitle>历史文件预览</AlertTitle>
                      <AlertDescription>
                        选择片段后可预览文件开头。全天任意时刻回放与精确时间定位仍待验证。
                      </AlertDescription>
                    </Alert>
                    {segment && (
                      <div className="selected-segment" role="status">
                        <span>已选片段</span>
                        <strong>
                          {clock(segment.startAt, data.timeZone)} —{" "}
                          {clock(segment.endAt, data.timeZone)}
                        </strong>
                        <span>
                          设备报告：{segment.codec ?? "编码未提供"}
                          ；实际编码以预览为准
                        </span>
                      </div>
                    )}
                    {segment && (
                      <PreviewPlayer
                        key={`${key}|${segment.id}`}
                        track={track}
                        date={date}
                        segmentId={segment.id}
                      />
                    )}
                    {!data.segments.length ? (
                      <Empty className="py-14">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <ArchiveIcon />
                          </EmptyMedia>
                          <EmptyTitle>这一天没有检索到录像</EmptyTitle>
                          <EmptyDescription>
                            尝试其他日期或轨道。此结果表示设备查询为空。
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <div className="segment-list">
                        <div className="segment-list-heading">
                          <h3>录像片段</h3>
                          <span>时间均按设备时区显示</span>
                        </div>
                        <ol>
                          {data.segments.map((item, index) => (
                            <li key={item.id}>
                              <button
                                type="button"
                                aria-pressed={selected === item.id}
                                className={cn(
                                  "segment-row",
                                  selected === item.id && "is-selected"
                                )}
                                onClick={() => setSelected(item.id)}
                              >
                                <span className="segment-index">
                                  {String(index + 1).padStart(2, "0")}
                                </span>
                                <span className="segment-time">
                                  {clock(item.startAt, data.timeZone)}
                                  <span className="text-muted-foreground">
                                    {" "}
                                    —{" "}
                                  </span>
                                  {clock(item.endAt, data.timeZone)}
                                </span>
                                <span className="segment-duration">
                                  {duration(
                                    Date.parse(item.endAt) -
                                      Date.parse(item.startAt)
                                  )}
                                </span>
                                <span className="segment-codec">
                                  {item.codec ?? "未知编码"}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </div>
        <footer className="console-footer">
          {/* 待定 */}
        </footer>
      </main>
    </div>
  )
}

function RecordingTimeline({
  data,
  selected,
  onSelect,
  zoom,
}: {
  data: Recordings
  selected: string
  onSelect: (id: string) => void
  zoom: number
}) {
  const start = Date.parse(data.range.startAt),
    total = Date.parse(data.range.endAt) - start
  const ticks = Array.from(
    { length: Math.ceil(total / 3600000) + 1 },
    (_, index) => Math.min(index * 3600000, total)
  )
  return (
    <div
      className="timeline-scroll"
      tabIndex={0}
      role="region"
      aria-label="全天录像时间轴，可横向滚动"
    >
      <div
        className="timeline-chart"
        style={{ minWidth: `${Math.max(640, 760 * zoom)}px` }}
      >
        <div className="timeline-ticks">
          {ticks.map((offset, index) => (
            <span key={offset} style={{ left: `${(offset / total) * 100}%` }}>
              {index % 2 === 0 || offset === total
                ? offset === total
                  ? "24:00"
                  : clock(
                      new Date(start + offset).toISOString(),
                      data.timeZone
                    ).slice(0, 5)
                : ""}
            </span>
          ))}
        </div>
        <div className="timeline-track">
          {ticks.map((offset) => (
            <span
              key={offset}
              className="timeline-gridline"
              style={{ left: `${(offset / total) * 100}%` }}
            />
          ))}
          {data.segments.map((segment, index) => {
            const a = Math.max(start, Date.parse(segment.startAt)),
              b = Math.min(start + total, Date.parse(segment.endAt))
            return (
              <button
                type="button"
                key={segment.id}
                className={cn(
                  "timeline-segment",
                  selected === segment.id && "is-selected"
                )}
                style={{
                  left: `${((a - start) / total) * 100}%`,
                  width: `${((b - a) / total) * 100}%`,
                }}
                aria-label={`片段 ${index + 1}，${clock(segment.startAt, data.timeZone)} 至 ${clock(segment.endAt, data.timeZone)}`}
                aria-pressed={selected === segment.id}
                title={`${clock(segment.startAt, data.timeZone)} — ${clock(segment.endAt, data.timeZone)}`}
                onClick={() => onSelect(segment.id)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
