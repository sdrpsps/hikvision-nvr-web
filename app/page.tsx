import { Suspense } from "react"
import { LiveConsole } from "@/components/live/console"
import { ConsoleLoading } from "@/components/console/loading"

export default function Page() {
  return (
    <Suspense fallback={<ConsoleLoading mode="live" />}>
      <LiveConsole />
    </Suspense>
  )
}
