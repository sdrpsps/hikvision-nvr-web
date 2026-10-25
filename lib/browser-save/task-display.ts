import type { SaveTask } from "./types"

export const active = (task: SaveTask) =>
  ["preparing", "saving", "stopping"].includes(task.state)
export const routineTaskMessages = new Set([
  "请选择保存位置。",
  "正在启动浏览器下载…",
  "正在连接媒体源…",
  "正在收尾并保存文件…",
  "正在补齐停止前画面的声音并保存…",
  "已保存到本机硬盘。",
  "已停止并保存已接收的录像。",
])

export function taskDetailMessage(task: SaveTask) {
  if (task.state === "failed" || task.state === "partial") return task.message
  return task.message && !routineTaskMessages.has(task.message)
    ? task.message
    : undefined
}

export function taskStateLabel(task: SaveTask) {
  return {
    preparing:
      task.source.mode === "live"
        ? "准备录制"
        : task.sourceBytes > 0
          ? "读取录像"
          : "准备下载",
    saving: task.source.mode === "live" ? "录制中" : "下载中",
    stopping: "收尾中",
    complete: task.saveMode === "download" ? "传送完成" : "已保存",
    partial: "部分保存",
    failed: "失败",
    cancelled: "已取消",
  }[task.state]
}

export function formatBytes(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
