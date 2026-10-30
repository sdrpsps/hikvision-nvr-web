import { Suspense } from "react"
import { RecordingConsole } from "@/components/recording/console"
import { ConsoleLoading } from "@/components/console/loading"

export default function PlaybackPage() {
  return (
    <Suspense fallback={<ConsoleLoading mode="playback" />}>
      <RecordingConsole />
    </Suspense>
  )
}
