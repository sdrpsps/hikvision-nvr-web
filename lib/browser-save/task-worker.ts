import { releaseDestination } from "./destination"
import type {
  SaveWorkerRequest,
  SaveWorkerEvent,
  SaveDestination,
  SaveSource,
} from "./types"
import type { SaveTaskRuntime } from "./task-runtime"

export function startTaskWorker(
  id: string,
  source: SaveSource,
  filename: string,
  destination: SaveDestination,
  runtime: SaveTaskRuntime
) {
  const {
    tasksRef,
    workers,
    watchdogs,
    update,
    notify,
    clearWatchdog,
    failWorker,
  } = runtime
  const worker = new Worker(new URL("./runner.worker.ts", import.meta.url), {
    type: "module",
  })
  workers.current.set(id, worker)
  worker.onmessage = (event: MessageEvent<SaveWorkerEvent>) => {
    if (workers.current.get(id) !== worker) return
    if (event.data.type === "ready") {
      if (tasksRef.current.find((task) => task.id === id)?.state !== "stopping")
        clearWatchdog(id)
      return
    }
    update((old) =>
      old.map((task) =>
        task.id === id ? { ...task, ...event.data.patch } : task
      )
    )
    if (event.data.type === "done") {
      clearWatchdog(id)
      const task = tasksRef.current.find((task) => task.id === id)
      notify(
        task?.state === "complete"
          ? "success"
          : task?.state === "partial"
            ? "warning"
            : task?.state === "failed"
              ? "error"
              : "info",
        task?.message ?? "任务已结束。",
        task
      )
      worker.terminate()
      workers.current.delete(id)
      releaseDestination(id)
    }
  }
  worker.onerror = () => {
    failWorker(id, "浏览器媒体处理意外中断，当前未完成文件可能未保存。")
  }
  const request: SaveWorkerRequest = {
    type: "start",
    id,
    source,
    filename,
    destination,
  }
  watchdogs.current.set(
    id,
    setTimeout(
      () => failWorker(id, "浏览器媒体处理启动超时，请重试；本次保存已停止。"),
      20000
    )
  )
  worker.postMessage(
    request,
    destination.type === "download" ? [destination.port] : []
  )
  update((old) =>
    old.map((task) =>
      task.id === id ? { ...task, message: "正在连接媒体源…" } : task
    )
  )
}
