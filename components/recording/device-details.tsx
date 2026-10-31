"use client"

import { useState } from "react"
import { InfoIcon } from "lucide-react"
import { useDevice } from "@/hooks/use-api"
import { useQueryErrorToast } from "@/hooks/use-query-error-toast"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"

export function DeviceDetails({
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
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] p-4 [&_[data-slot=popover-title]]:text-xs [&_[data-slot=popover-title]]:font-medium [&_[data-slot=popover-title]]:text-muted-foreground [&_dd]:m-0 [&_dd]:[overflow-wrap:anywhere] [&_dl]:mt-2 [&_dl]:grid [&_dl]:gap-3 [&_dl]:border-t [&_dl]:pt-4 [&_dl]:text-[0.8125rem] [&_dl]:leading-normal [&_dl>div]:grid [&_dl>div]:grid-cols-[3.25rem_minmax(0,1fr)] [&_dl>div]:gap-3 [&_dt]:text-muted-foreground"
      >
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
          <p className="mt-0.5 text-lg leading-[1.4] font-semibold tracking-[-0.025em] [overflow-wrap:anywhere]">
            {device.model}
          </p>
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
