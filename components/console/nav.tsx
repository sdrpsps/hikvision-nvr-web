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
      className="group/nav-label inline-flex items-center gap-2"
      data-pending={pending}
      aria-busy={pending}
    >
      <span className="grid size-4 shrink-0" aria-hidden="true">
        <Icon className="col-start-1 row-start-1 transition-opacity duration-100 ease-out group-data-[pending=true]/nav-label:opacity-0 group-data-[pending=true]/nav-label:delay-[120ms]" />
        <LoaderCircleIcon className="col-start-1 row-start-1 opacity-0 transition-opacity duration-100 ease-out group-data-[pending=true]/nav-label:animate-spin group-data-[pending=true]/nav-label:opacity-100 group-data-[pending=true]/nav-label:delay-[120ms]" />
      </span>
      {label}
      <span role="status" className="sr-only">
        {pending ? `正在切换到${label}` : null}
      </span>
    </span>
  )
}

export function ConsoleNav({ active }: { active: "live" | "playback" }) {
  const linkClassName =
    "flex h-9 items-center justify-center gap-2 rounded-md px-3.5 py-2 text-[0.8125rem] font-normal text-muted-foreground hover:bg-secondary hover:text-secondary-foreground aria-[current=page]:bg-secondary aria-[current=page]:font-semibold aria-[current=page]:text-secondary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:flex-1 [&_svg]:size-4"

  return (
    <nav
      className="console-nav flex items-center gap-1.5 max-md:order-3 max-md:col-span-2 max-md:w-full max-md:gap-1"
      aria-label="主导航"
    >
      <Link
        href="/"
        className={linkClassName}
        aria-current={active === "live" ? "page" : undefined}
      >
        <NavLabel mode="live" />
      </Link>
      <Link
        href="/playback"
        className={linkClassName}
        aria-current={active === "playback" ? "page" : undefined}
      >
        <NavLabel mode="playback" />
      </Link>
      <SaveTasksButton />
    </nav>
  )
}
