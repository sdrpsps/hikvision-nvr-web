"use client"

import { useQueryStates } from "nuqs"
import { playbackUrlParsers } from "@/lib/url-state"
import { useCallback, useState } from "react"
import { toast } from "sonner"
import {
  ArchiveIcon,
  ChevronDownIcon,
  InfoIcon,
  MonitorIcon,
  RefreshCwIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
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
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { dateSchema, type Recordings } from "@/shared/contracts"
import { useChannels, useDevice, useRecordings } from "@/hooks/use-api"
import { useQueryErrorToast } from "@/hooks/use-query-error-toast"
import { cn } from "@/lib/utils"
import { PreviewPlayer } from "@/components/preview-player"
import { ConsoleNav } from "@/components/console-nav"
import { SaveActivityBar } from "@/components/browser-save-provider"
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
type RecordingSelection = {
  key: string
  selected: string
  continuous: boolean
  automatic: string
  listOpen: boolean
}

function emptySelection(key: string): RecordingSelection {
  return {
    key,
    selected: "",
    continuous: false,
    automatic: "",
    listOpen: false,
  }
}

export function RecordingConsole() {
  const channelsQuery = useChannels()
  const resources = channelsQuery.data
  const resourceError = channelsQuery.error?.message
  const [{ track: preferredTrack, date: preferredDate, zoom }, setUrlState] =
    useQueryStates(playbackUrlParsers, { shallow: true, scroll: false })
  function setTrack(value: string) {
    void setUrlState({ track: value, date }, { history: "push" })
  }
  function setDate(value: string) {
    void setUrlState({ track, date: value }, { history: "push" })
  }
  const track = resources?.channels.some(
    (channel) => channel.id === preferredTrack
  )
    ? preferredTrack
    : (resources?.channels[0]?.id ?? "")
  const date = preferredDate || resources?.today || ""
  const recordingsQuery = useRecordings({ track, date })
  const [refresh, setRefresh] = useState(0)
  const [selection, setSelection] = useState(() => emptySelection(""))
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
  const key = `${track}|${date}|${refresh}|${recordingsQuery.dataUpdatedAt}`
  const activeSelection =
    selection.key === key ? selection : emptySelection(key)
  const { selected, continuous, automatic, listOpen } = activeSelection
  function updateSelection(patch: Partial<Omit<RecordingSelection, "key">>) {
    setSelection((old) => ({
      ...(old.key === key ? old : emptySelection(key)),
      ...patch,
    }))
  }
  const error = recordingsQuery.error?.message
  useQueryErrorToast(
    resourceError ? channelsQuery : recordingsQuery,
    "录像查询失败"
  )
  const data =
    !error && !recordingsQuery.isFetching ? recordingsQuery.data : undefined
  const validDate = dateSchema.safeParse(date).success
  const loading =
    !!resources && !!track && validDate && recordingsQuery.isFetching

  function refreshQueries() {
    setRefresh((value) => value + 1)
    void channelsQuery.refetch()
    if (track && validDate) void recordingsQuery.refetch()
  }

  const segment = data?.segments.find((segment) => segment.id === selected)
  function selectSegment(id: string) {
    updateSelection({ selected: id, automatic: "" })
  }
  function stopSequence() {
    updateSelection({ automatic: "", continuous: false })
  }
  function nextSegment() {
    if (!continuous || !data || !segment) return
    const next =
      data.segments[
        data.segments.findIndex((item) => item.id === segment.id) + 1
      ]
    if (!next) {
      updateSelection({
        automatic: "",
        continuous: false,
      })
      toast.info("已播放到当日最后一个片段。")
      return
    }
    const gap = Date.parse(next.startAt) - Date.parse(segment.endAt)
    if (gap > 1000)
      toast.warning(
        `已切换到下一片段；搜索结果中间有 ${duration(gap)}未覆盖区间。`
      )
    updateSelection({
      automatic: next.id,
      selected: next.id,
    })
  }
  // This is a query snapshot. Future hours are neither covered nor missing yet.
  const observedEnd = data
    ? Math.min(Date.parse(data.range.endAt), recordingsQuery.dataUpdatedAt)
    : 0
  const coverage =
    data?.coverage.reduce(
      (sum, item) =>
        sum +
        Math.max(
          0,
          Math.min(Date.parse(item.endAt), observedEnd) -
            Date.parse(item.startAt)
        ),
      0
    ) ?? 0
  const gaps =
    data?.gaps.filter(
      (item) =>
        Date.parse(item.startAt) < Math.min(Date.parse(item.endAt), observedEnd)
    ) ?? []

  return (
    <div className="console-shell playback-shell">
      <header className="console-header">
        <div className="console-brand">
          <div className="brand-mark">
            <MonitorIcon aria-hidden="true" />
          </div>
          <span>NVR 控制台</span>
        </div>
        <ConsoleNav active="playback" />
      </header>
      <SaveActivityBar />
      <main className="console-main playback-main">
        <h1 className="sr-only">录像回放</h1>
        <section className="playback-query-bar" aria-label="检索录像">
          <FieldGroup className="playback-query-fields">
            <Field data-disabled={!resources?.channels.length}>
              <FieldLabel htmlFor="track">摄像头</FieldLabel>
              <Select
                items={
                  resources?.channels.map((channel) => ({
                    label: channel.name,
                    value: channel.id,
                  })) ?? []
                }
                value={track}
                onValueChange={(value) => {
                  setSelection(emptySelection(""))
                  setTrack(value ?? "")
                }}
                disabled={!resources?.channels.length}
              >
                <SelectTrigger id="track" className="w-full">
                  <SelectValue placeholder="暂无可用摄像头" />
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
            <Field
              data-invalid={!!date && !validDate}
              data-disabled={!resources}
            >
              <FieldLabel htmlFor="date">日期</FieldLabel>
              <RecordingDatePicker
                id="date"
                value={date}
                timeZone={resources?.timeZone ?? "Asia/Shanghai"}
                onChange={(value) => {
                  setSelection(emptySelection(""))
                  setDate(value)
                }}
                disabled={!resources}
              />
            </Field>
          </FieldGroup>
          <div className="query-actions">
            <DeviceDetails
              channelCount={resources?.channels.length}
              timeZone={resources?.timeZone}
            />
            <Button variant="outline" onClick={refreshQueries}>
              <RefreshCwIcon data-icon="inline-start" />
              刷新
            </Button>
          </div>
          {!!date && !validDate && (
            <p className="text-sm text-destructive" role="alert">
              请选择有效的日期。
            </p>
          )}
        </section>
        <section
          className="recording-content"
          aria-label="录像查询结果"
          aria-busy={loading}
        >
          {resourceError || error ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>暂时无法显示录像</EmptyTitle>
                <EmptyDescription>请刷新后重试。</EmptyDescription>
              </EmptyHeader>
            </Empty>
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
                <EmptyTitle>暂无可用摄像头</EmptyTitle>
                <EmptyDescription>
                  请检查设备连接和账号查询权限，再刷新。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {loading ? (
            <div
              className="flex flex-col gap-4"
              role="status"
              aria-label="正在查询录像"
            >
              <Skeleton className="h-60 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}
          {data && (
            <>
              {data.segments.length > 0 ? (
                <div className="playback-focus">
                  {segment ? (
                    <>
                      <div className="selected-segment" role="status">
                        <span>已选片段</span>
                        <strong>
                          {clock(segment.startAt, data.timeZone)} —{" "}
                          {segmentEnd(segment.endAt, data)}
                        </strong>
                      </div>
                      <PreviewPlayer
                        key={`${key}|${segment.id}`}
                        track={track}
                        date={date}
                        segmentId={segment.id}
                        timeZone={data.timeZone}
                        channelName={
                          resources?.channels.find(
                            (channel) => channel.id === track
                          )?.name
                        }
                        autoStart={automatic === segment.id}
                        initialPreferences={preferences}
                        onPreferencesChange={updatePreferences}
                        onPlaybackEnded={continuous ? nextSegment : undefined}
                        onStop={stopSequence}
                        playbackControls={
                          <FieldGroup className="continuous-control">
                            <Field orientation="horizontal">
                              <Switch
                                id="continuous-playback"
                                aria-label="连续播放"
                                checked={continuous}
                                onCheckedChange={(checked) => {
                                  updateSelection({
                                    continuous: checked,
                                    automatic: checked ? automatic : "",
                                  })
                                }}
                              />
                              <FieldLabel htmlFor="continuous-playback">
                                连续播放
                              </FieldLabel>
                            </Field>
                          </FieldGroup>
                        }
                      />
                    </>
                  ) : (
                    <Empty className="playback-selection-empty">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ArchiveIcon />
                        </EmptyMedia>
                        <EmptyTitle>选择录像片段</EmptyTitle>
                        <EmptyDescription>
                          在下方选择要查看的录像。
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                </div>
              ) : (
                <Empty className="py-14">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ArchiveIcon />
                    </EmptyMedia>
                    <EmptyTitle>这一天没有检索到录像</EmptyTitle>
                    <EmptyDescription>试试其他日期或摄像头。</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              <section className="recording-distribution" aria-label="当日录像">
                <div className="timeline-toolbar">
                  <div className="distribution-heading">
                    <h2>当日录像</h2>
                  </div>
                  <ToggleGroup
                    aria-label="时间轴缩放"
                    value={[zoom]}
                    onValueChange={(values) => {
                      if (
                        values[0] === "1" ||
                        values[0] === "2" ||
                        values[0] === "4"
                      )
                        void setUrlState({ track, date, zoom: values[0] })
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
                <RecordingTimeline
                  data={data}
                  selected={selected}
                  onSelect={selectSegment}
                  zoom={Number(zoom)}
                />
                <div className="coverage-summary">
                  <span>{data.segments.length} 个录像片段</span>
                  <span>
                    覆盖 <strong>{duration(coverage)}</strong>
                  </span>
                  {gaps.length > 0 && (
                    <span>
                      缺口 <strong>{gaps.length} 处</strong>
                    </span>
                  )}
                  {observedEnd < Date.parse(data.range.endAt) && (
                    <span>截至本次查询</span>
                  )}
                </div>
              </section>
              {data.segments.length > 0 && (
                <section className="segment-list" aria-label="录像片段列表">
                  <Button
                    type="button"
                    variant="ghost"
                    className="segment-list-toggle"
                    aria-expanded={listOpen}
                    aria-controls="recording-segments"
                    onClick={() => updateSelection({ listOpen: !listOpen })}
                  >
                    片段列表
                    <ChevronDownIcon
                      data-icon="inline-end"
                      aria-hidden="true"
                    />
                  </Button>
                  {listOpen && (
                    <ol id="recording-segments">
                      {data.segments.map((item, index) => (
                        <li key={item.id}>
                          <Button
                            type="button"
                            variant={
                              selected === item.id ? "secondary" : "ghost"
                            }
                            aria-label={`选择片段 ${index + 1}，${clock(item.startAt, data.timeZone)} 至 ${segmentEnd(item.endAt, data)}`}
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
                              {clock(item.startAt, data.timeZone)} —{" "}
                              {segmentEnd(item.endAt, data)}
                            </span>
                            <span className="segment-duration">
                              {duration(
                                Date.parse(item.endAt) -
                                  Date.parse(item.startAt)
                              )}
                            </span>
                          </Button>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function DeviceDetails({
  channelCount,
  timeZone,
}: {
  channelCount?: number
  timeZone?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" />}>
        <InfoIcon data-icon="inline-start" />
        设备信息
      </PopoverTrigger>
      <PopoverContent align="end" className="device-details">
        <PopoverTitle>设备信息</PopoverTitle>
        {open && (
          <DeviceDetailsContent
            channelCount={channelCount}
            timeZone={timeZone}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function DeviceDetailsContent({
  channelCount,
  timeZone,
}: {
  channelCount?: number
  timeZone?: string
}) {
  const deviceQuery = useDevice({ enabled: true })
  const device = deviceQuery.data
  const error = deviceQuery.error?.message
  useQueryErrorToast(deviceQuery, "设备信息读取失败")
  return (
    <>
      {device ? (
        <>
          <p className="device-model">{device.model}</p>
          <dl>
            <div>
              <dt>固件</dt>
              <dd>{device.firmware}</dd>
            </div>
            {channelCount !== undefined && (
              <div>
                <dt>摄像头</dt>
                <dd>{channelCount} 路</dd>
              </div>
            )}
            {timeZone && (
              <div>
                <dt>时区</dt>
                <dd>
                  {timeZone === "Asia/Shanghai"
                    ? "北京时间（UTC+8）"
                    : timeZone}
                </dd>
              </div>
            )}
          </dl>
        </>
      ) : error && !deviceQuery.isFetching ? (
        <>
          <p className="text-sm text-muted-foreground">暂时无法显示设备信息</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void deviceQuery.refetch()}
          >
            重试
          </Button>
        </>
      ) : (
        <p role="status">正在读取设备信息…</p>
      )}
    </>
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
    <ScrollArea
      className="timeline-scroll-area"
      scrollbars="horizontal"
      contentProps={{ style: { minWidth: "fit-content" } }}
      viewportProps={{
        className: "timeline-scroll",
        tabIndex: 0,
        role: "region",
        "aria-label": "全天录像时间轴，可横向滚动",
      }}
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
    </ScrollArea>
  )
}
