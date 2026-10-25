import type { Recordings } from "@/shared/contracts"

export function clock(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso))
}
export function duration(ms: number) {
  const seconds = Math.round(ms / 1000)
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60)
  return hours
    ? `${hours} 小时 ${minutes} 分`
    : minutes
      ? `${minutes} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`
}
export function segmentEnd(iso: string, data: Recordings) {
  return Date.parse(iso) === Date.parse(data.range.endAt)
    ? "24:00:00"
    : clock(iso, data.timeZone)
}
