import { Suspense } from "react"
import { LiveConsole } from "@/components/live-console"

export default function Page() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4">
          正在加载控制台…
        </p>
      }
    >
      <LiveConsole />
    </Suspense>
  )
}
