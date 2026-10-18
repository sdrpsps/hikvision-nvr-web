import Link from "next/link"
import { MonitorIcon, ArchiveIcon } from "lucide-react"

export function ConsoleNav({ active }: { active: "live" | "playback" }) {
  return (
    <nav className="console-nav" aria-label="主导航">
      <Link href="/" aria-current={active === "live" ? "page" : undefined}>
        <MonitorIcon aria-hidden="true" />
        实时预览
      </Link>
      <Link
        href="/playback"
        aria-current={active === "playback" ? "page" : undefined}
      >
        <ArchiveIcon aria-hidden="true" />
        录像回放
      </Link>
    </nav>
  )
}
