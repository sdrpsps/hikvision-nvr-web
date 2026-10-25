import { NuqsAdapter } from "nuqs/adapters/next/app"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ConsoleScrollArea } from "@/components/console-scroll-area"
import { ThemeProvider } from "@/components/theme-provider"
import { QueryProvider } from "@/components/query-provider"
import { BrowserSaveProvider } from "@/components/browser-save-provider"
import { Toaster } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "NVR 控制台",
  description: "多窗口实时预览与历史录像查询。",
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
