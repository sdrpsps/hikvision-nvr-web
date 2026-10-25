import { Suspense } from "react"
import { RecordingConsole } from "@/components/recording-console"

export default function PlaybackPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4">
          正在加载控制台…
        </p>
      }
    >
      <RecordingConsole />
    </Suspense>
  )
}
