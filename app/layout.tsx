import { NuqsAdapter } from "nuqs/adapters/next/app"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ConsoleScrollArea } from "@/components/console/scroll-area"
import { ThemeProvider } from "@/components/theme-provider"
import { QueryProvider } from "@/components/query-provider"
import { BrowserSaveProvider } from "@/components/browser-save-provider"
import { Toaster } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "海康威视 NVR 网页客户端 · Hikvision NVR Web",
  description:
    "海康威视 NVR 网页客户端，支持实时预览、录像回放、通道改名、浏览器录制与片段下载。",
}

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        geist.variable
      )}
    >
      <body>
        <ThemeProvider>
          <QueryProvider>
            <BrowserSaveProvider>
              <NuqsAdapter>
                <ConsoleScrollArea>{children}</ConsoleScrollArea>
              </NuqsAdapter>
            </BrowserSaveProvider>
          </QueryProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
