import {
  chooseDestination,
  releaseDestination,
  saveCapability,
} from "./destination"
import { active } from "./task-display"
import { mediaClock, safeFilename, type SaveSource } from "./types"
import { startTaskWorker } from "./task-worker"
import type { SaveTaskRuntime } from "./task-runtime"
import { recordingRange } from "./recording-time"

export async function startSaveTask(
  source: SaveSource,
  runtime: SaveTaskRuntime
) {
  const { tasksRef, workers, update, notify, clearWatchdog } = runtime
  const capability = saveCapability()
  if (capability === "insecure" || capability === "unsupported") {
    notify(
      "error",
      capability === "insecure"
        ? "直接写盘需要 HTTPS；本机调试请使用 localhost 地址。"
        : "当前浏览器不支持流式保存，请使用最新版 Chrome 或 Edge。"
    )
    return
  }
  if (tasksRef.current.filter(active).length >= 4) {
    notify("warning", "最多同时保存 4 个任务，请先停止其他任务。")
    return
  }
  if (
    source.mode === "live" &&
    tasksRef.current.some(
      (task) =>
        active(task) &&
        task.source.mode === "live" &&
        task.source.track === source.track
    )
  ) {
    notify("info", `${source.channelName} 已在录制，请在任务面板中查看。`)
    return
  }
  const id = crypto.randomUUID()
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: source.timeZone ?? "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date())
    .replace(" ", "_")
    .replaceAll(":", "-")
  const range =
    source.mode === "history"
      ? `_${(recordingRange(source, source.startSeconds, source.endSeconds) ?? `${source.date}_文件内${mediaClock(source.startSeconds)}-${mediaClock(source.endSeconds)}`).replaceAll(":", "-").replaceAll(" ", "_").replace("—", "至")}`
      : `_${stamp}`
  const filename = `${safeFilename(source.channelName)}_${source.mode === "live" ? "手动录制" : "录像片段"}${range}_${id.slice(0, 6)}.mkv`
  update((old) => [
    ...old.filter(
      (task) => active(task) || old.indexOf(task) >= old.length - 19
    ),
    {
      id,
      source,
      filename,
      state: "preparing",
      bytes: 0,
      sourceBytes: 0,
      durationSeconds: 0,
      audioPackets: 0,
      files: 0,
      createdAt: Date.now(),
      message:
        capability === "download" ? "正在启动浏览器下载…" : "请选择保存位置。",
    },
  ])
  try {
    // Called in the click handler before any network await, preserving the
    // transient user activation required by the browser's file picker.
    const destination = await chooseDestination(
      id,
      filename,
      source.mode === "live"
    )
    if (
      tasksRef.current.find((task) => task.id === id)?.state === "cancelled"
    ) {
      if (destination.type === "download") destination.port.close()
      releaseDestination(id)
      return
    }
    update((old) =>
      old.map((task) =>
        task.id === id ? { ...task, saveMode: destination.type } : task
      )
    )
    startTaskWorker(id, source, filename, destination, runtime)
  } catch (error) {
    clearWatchdog(id)
    workers.current.get(id)?.terminate()
    workers.current.delete(id)
    releaseDestination(id)
    if (tasksRef.current.find((task) => task.id === id)?.state === "cancelled")
      return
    if (error instanceof DOMException && error.name === "AbortError") {
      update((old) => old.filter((task) => task.id !== id))
      return
    }
    const message =
      error instanceof Error ? error.message : "无法准备保存位置，请重试。"
    update((old) =>
      old.map((task) =>
        task.id === id ? { ...task, state: "failed", message } : task
      )
    )
    notify(
      "error",
      message,
      tasksRef.current.find((task) => task.id === id)
    )
  }
}
