"use client"

import { useState, useEffect } from "react"
import { saveCapability } from "@/lib/browser-save/destination"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function SaveCapabilityNotice() {
  const [capability, setCapability] = useState("pending")
  useEffect(() => {
    const timeout = setTimeout(() => setCapability(saveCapability()), 0)
    return () => clearTimeout(timeout)
  }, [])
  if (capability === "download")
    return (
      <p className="text-sm text-muted-foreground">
        文件保存到浏览器的下载位置，可在下载列表中查看。
      </p>
    )
  return capability === "insecure" || capability === "unsupported" ? (
    <Alert variant="destructive">
      <AlertTitle>当前环境无法流式保存</AlertTitle>
      <AlertDescription>
        {capability === "insecure"
          ? "请通过 HTTPS 或本机 localhost 打开。"
          : "请使用支持文件直写或流式下载的浏览器。"}
      </AlertDescription>
    </Alert>
  ) : null
}
