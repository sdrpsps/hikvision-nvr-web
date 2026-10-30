import { MonitorIcon } from "lucide-react"
import { ConsoleNav } from "@/components/console/nav"

export function ConsoleHeader({ active }: { active: "live" | "playback" }) {
  return (
    <header className="console-header">
      <div className="console-brand">
        <div className="brand-mark">
          <MonitorIcon aria-hidden="true" />
        </div>
        <span>NVR 控制台</span>
      </div>
      <ConsoleNav active={active} />
    </header>
  )
}
