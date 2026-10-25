"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { releaseDestination } from "@/lib/browser-save/destination"
import {
  active,
  routineTaskMessages,
  taskStateLabel,
} from "@/lib/browser-save/task-display"
import { startSaveTask } from "@/lib/browser-save/start-task"
import type {
  SaveSource,
  SaveTask,
  SaveWorkerRequest,
} from "@/lib/browser-save/types"

export function useSaveTasks(showTasks: () => void) {
  const [tasks, setTasks] = useState<SaveTask[]>([])
  const tasksRef = useRef(tasks)
  const workers = useRef(new Map<string, Worker>())
  const watchdogs = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const notify = useCallback(
    (
      kind: "success" | "warning" | "error" | "info",
      message: string,
      task?: SaveTask
    ) => {
      toast[kind](
        task ? `${task.source.channelName} · ${taskStateLabel(task)}` : message,
        {
          id: task ? `save-${task.id}` : "save-start-notice",
          description:
            task &&
            (kind === "error" ||
              kind === "warning" ||
              !routineTaskMessages.has(message))
              ? message
              : undefined,
          duration: kind === "error" || kind === "warning" ? 12000 : 7000,
          action: {
            label: "查看任务",
            onClick: showTasks,
          },
        }
      )
    },
    [showTasks]
  )
  const update = useCallback((fn: (old: SaveTask[]) => SaveTask[]) => {
    const next = fn(tasksRef.current)
    tasksRef.current = next
    setTasks(next)
  }, [])
  const clearWatchdog = useCallback((id: string) => {
    clearTimeout(watchdogs.current.get(id))
    watchdogs.current.delete(id)
  }, [])
  const failWorker = useCallback(
    (id: string, message: string) => {
      clearWatchdog(id)
      workers.current.get(id)?.terminate()
      workers.current.delete(id)
      releaseDestination(id)
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
    },
    [clearWatchdog, notify, update]
  )
  const stop = useCallback(
    (id: string) => {
      if (!workers.current.has(id)) {
        releaseDestination(id)
        update((old) =>
          old.map((task) =>
            task.id === id
              ? {
                  ...task,
                  state: "cancelled",
                  message: "已取消，未开始读取媒体。",
                }
              : task
          )
        )
        return
      }
      workers.current
        .get(id)
        ?.postMessage({ type: "stop" } satisfies SaveWorkerRequest)
      clearWatchdog(id)
      watchdogs.current.set(
        id,
        setTimeout(
          () =>
            failWorker(
              id,
              "保存收尾超时，已停止媒体连接；请检查已保存文件，当前未完成文件可能未保存。"
            ),
          60000
        )
      )
      update((old) =>
        old.map((task) =>
          task.id === id
            ? { ...task, state: "stopping", message: "正在收尾并保存文件…" }
            : task
        )
      )
    },
    [clearWatchdog, failWorker, update]
  )
  const start = useCallback(
    (source: SaveSource) =>
      startSaveTask(source, {
        tasksRef,
        workers,
        watchdogs,
        notify,
        update,
        clearWatchdog,
        failWorker,
      }),
    [clearWatchdog, failWorker, notify, update]
  )
  useEffect(() => {
    const current = workers.current
    const currentWatchdogs = watchdogs.current
    const warn = (event: BeforeUnloadEvent) => {
      if (!tasksRef.current.some(active)) return
      event.preventDefault()
      event.returnValue = ""
    }
    const pagehide = () => {
      for (const worker of current.values())
        worker.postMessage({ type: "stop" } satisfies SaveWorkerRequest)
    }
    window.addEventListener("beforeunload", warn)
    window.addEventListener("pagehide", pagehide)
    return () => {
      window.removeEventListener("beforeunload", warn)
      window.removeEventListener("pagehide", pagehide)
      for (const worker of current.values()) worker.terminate()
      current.clear()
      for (const timeout of currentWatchdogs.values()) clearTimeout(timeout)
      currentWatchdogs.clear()
    }
  }, [])

  return {
    tasks,
    start,
    stop,
    dismiss: (id: string) =>
      update((old) => old.filter((task) => task.id !== id || active(task))),
  }
}
