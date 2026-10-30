"use client"

import Link, { useLinkStatus } from "next/link"
import { MonitorIcon, ArchiveIcon, LoaderCircleIcon } from "lucide-react"
import { SaveTasksButton } from "@/components/browser-save-provider"

function NavLabel({ mode }: { mode: "live" | "playback" }) {
  const { pending } = useLinkStatus()
  const Icon = mode === "live" ? MonitorIcon : ArchiveIcon
  const label = mode === "live" ? "实时预览" : "录像回放"

  return (
    <span
      className="console-nav-label"
      data-pending={pending}
      aria-busy={pending}
    >
      <span className="console-nav-icon" aria-hidden="true">
        <Icon className="console-nav-idle-icon" />
        <LoaderCircleIcon className="console-nav-pending-icon" />
      </span>
      {label}
      <span role="status" className="sr-only">
        {pending ? `正在切换到${label}` : null}
      </span>
    </span>
  )
}

export function ConsoleNav({ active }: { active: "live" | "playback" }) {
  return (
    <nav className="console-nav" aria-label="主导航">
      <Link href="/" aria-current={active === "live" ? "page" : undefined}>
        <NavLabel mode="live" />
      </Link>
      <Link
        href="/playback"
        aria-current={active === "playback" ? "page" : undefined}
      >
        <NavLabel mode="playback" />
      </Link>
      <SaveTasksButton />
    </nav>
  )
}
