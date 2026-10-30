import { Skeleton } from "@/components/ui/skeleton"

export function RecordingLoading({
  label = "正在查询录像",
}: {
  label?: string
}) {
  return (
    <div className="recording-loading" role="status" aria-label={label}>
      <span className="sr-only">{label}…</span>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="console-loading-picture" />
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-8 w-36" />
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-44 max-w-full" />
      </div>
    </div>
  )
}
