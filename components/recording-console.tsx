"use client"

import { useCallback, useEffect, useState } from "react"
import {
  ArchiveIcon,
  CircleAlertIcon,
  ClockIcon,
  RefreshCwIcon,
  VideoIcon,
} from "lucide-react"
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { RecordingDatePicker } from "@/components/recording-date-picker"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
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
import type { PlaybackPreferences } from "@/components/hls-video"

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
function segmentEnd(iso: string, data: Recordings) {
  return Date.parse(iso) === Date.parse(data.range.endAt)
    ? "24:00:00"
    : clock(iso, data.timeZone)
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
  const [continuous, setContinuous] = useState(false)
  const [automatic, setAutomatic] = useState("")
  const [sequenceNotice, setSequenceNotice] = useState("")
  const [preferences, setPreferences] = useState<PlaybackPreferences>({
    rate: 1,
    sound: false,
  })
  const updatePreferences = useCallback(
    (value: Partial<PlaybackPreferences>) => {
      setPreferences((old) => ({ ...old, ...value }))
    },
    []
  )
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
        setAutomatic("")
        setContinuous(false)
        setSequenceNotice("")
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
  function selectSegment(id: string) {
    setAutomatic("")
    setSequenceNotice("")
    setSelected(id)
  }
  function stopSequence() {
    setAutomatic("")
    setContinuous(false)
    setSequenceNotice("")
  }
  function nextSegment() {
    if (!continuous || !data || !segment) return
    const next =
      data.segments[
        data.segments.findIndex((item) => item.id === segment.id) + 1
      ]
    if (!next) {
      setAutomatic("")
      setContinuous(false)
      setSequenceNotice("已播放到当日最后一个片段。")
      return
    }
    const gap = Date.parse(next.startAt) - Date.parse(segment.endAt)
    setSequenceNotice(
      gap > 1000
        ? `已切换到下一片段；搜索结果中间有 ${duration(gap)}未覆盖区间。`
        : "已切换到下一片段。"
    )
    setAutomatic(next.id)
    setSelected(next.id)
  }
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
                <Select
                  items={
                    resources?.channels.map((channel) => ({
                      label: channel.name,
                      value: channel.id,
                    })) ?? []
                  }
                  value={track}
                  onValueChange={(value) => setTrack(value ?? "")}
                  disabled={!resources?.channels.length}
                >
                  <SelectTrigger id="track" className="w-full">
                    <SelectValue placeholder="暂无可用轨道" />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {resources?.channels.map((channel) => (
                        <SelectItem key={channel.id} value={channel.id}>
                          {channel.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field data-invalid={!!date && !validDate}>
                <FieldLabel htmlFor="date">设备日期</FieldLabel>
                <RecordingDatePicker
                  id="date"
                  value={date}
                  timeZone={resources?.timeZone ?? "Asia/Shanghai"}
                  onChange={setDate}
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
                    <div className="timeline-toolbar">
                      <h3>全天时间轴</h3>
                      <div className="flex items-center gap-3">
                        <span className="timeline-legend">有录像</span>
                        <ToggleGroup
                          aria-label="时间轴缩放"
                          value={[zoom]}
                          onValueChange={(values) => {
                            if (values[0]) setZoom(values[0])
                          }}
                          variant="outline"
                          size="sm"
                          spacing={0}
                        >
                          <ToggleGroupItem value="1">全天</ToggleGroupItem>
                          <ToggleGroupItem value="2">2 倍</ToggleGroupItem>
                          <ToggleGroupItem value="4">4 倍</ToggleGroupItem>
                        </ToggleGroup>
                      </div>
                    </div>
                    <RecordingTimeline
                      data={data}
                      selected={selected}
                      onSelect={selectSegment}
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
                    {segment && (
                      <div className="selected-segment" role="status">
                        <span>已选片段</span>
                        <strong>
                          {clock(segment.startAt, data.timeZone)} —{" "}
                          {segmentEnd(segment.endAt, data)}
                        </strong>
                        <span>
                          设备报告：{segment.codec ?? "编码未提供"}
                          ；实际编码以预览为准
                        </span>
                      </div>
                    )}
                    {segment && (
                      <FieldGroup>
                        <Field orientation="horizontal">
                          <Switch
                            id="continuous-playback"
                            aria-label="连续播放"
                            checked={continuous}
                            onCheckedChange={(checked) => {
                              setContinuous(checked)
                              if (!checked) setAutomatic("")
                              setSequenceNotice("")
                            }}
                          />
                          <FieldLabel htmlFor="continuous-playback">
                            连续播放下一片段
                          </FieldLabel>
                        </Field>
                      </FieldGroup>
                    )}
                    {sequenceNotice && (
                      <p
                        role="status"
                        className="text-sm text-muted-foreground"
                      >
                        {sequenceNotice}
                      </p>
                    )}
                    {segment && (
                      <PreviewPlayer
                        key={`${key}|${segment.id}`}
                        track={track}
                        date={date}
                        segmentId={segment.id}
                        autoStart={automatic === segment.id}
                        initialPreferences={preferences}
                        onPreferencesChange={updatePreferences}
                        onPlaybackEnded={continuous ? nextSegment : undefined}
                        onStop={stopSequence}
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
                              <Button
                                type="button"
                                variant={
                                  selected === item.id ? "secondary" : "ghost"
                                }
                                aria-pressed={selected === item.id}
                                className={cn(
                                  "segment-row",
                                  selected === item.id && "is-selected"
                                )}
                                onClick={() => selectSegment(item.id)}
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
                                  {segmentEnd(item.endAt, data)}
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
                              </Button>
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
        <footer className="console-footer">{/* 待定 */}</footer>
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
              <Button
                type="button"
                variant="recording"
                key={segment.id}
                className={cn(
                  "timeline-segment",
                  selected === segment.id && "is-selected"
                )}
                style={{
                  left: `${((a - start) / total) * 100}%`,
                  width: `${((b - a) / total) * 100}%`,
                }}
                aria-label={`片段 ${index + 1}，${clock(segment.startAt, data.timeZone)} 至 ${segmentEnd(segment.endAt, data)}`}
                aria-pressed={selected === segment.id}
                title={`${clock(segment.startAt, data.timeZone)} — ${segmentEnd(segment.endAt, data)}`}
                onClick={() => onSelect(segment.id)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
