"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react"

const subscribe = () => () => {}

const Toaster = (props: ToasterProps) => {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
  return mounted ? <PortalToaster {...props} /> : null
}

const PortalToaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const [container] = useState(() => document.createElement("div"))

  useEffect(() => {
    // Move one stable portal host so fullscreen changes preserve toast timers
    // and never create a second subscription to Sonner's notification store.
    const move = () => {
      const target = document.fullscreenElement ?? document.body
      target.appendChild(container)
    }
    move()
    document.addEventListener("fullscreenchange", move)
    return () => {
      document.removeEventListener("fullscreenchange", move)
      container.remove()
    }
  }, [container])

  return createPortal(
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-right"
      closeButton
      richColors
      visibleToasts={4}
      customAriaLabel="通知"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: "关闭提示",
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />,
    container
  )
}

export { Toaster }
