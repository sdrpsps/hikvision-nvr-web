import { MonitorIcon } from "lucide-react"
import { ConsoleNav } from "@/components/console/nav"

export function ConsoleHeader({ active }: { active: "live" | "playback" }) {
  return (
    <header className="console-header grid min-h-15 shrink-0 grid-cols-[1fr_auto_1fr] items-center justify-between gap-4 border-b bg-card px-6 py-2.5 max-md:grid-cols-[1fr_auto] max-md:gap-x-4 max-md:gap-y-2 max-md:px-4 [&>:last-child:not(nav)]:justify-self-end">
      <div className="flex items-center gap-2.5 justify-self-start text-[0.9375rem] font-semibold whitespace-nowrap">
        <div className="grid place-items-center text-primary [&_svg]:size-5">
          <MonitorIcon aria-hidden="true" />
        </div>
        <span>NVR 控制台</span>
      </div>
      <ConsoleNav active={active} />
    </header>
  )
}
