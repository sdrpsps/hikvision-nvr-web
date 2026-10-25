import type { SaveTask } from "./types"

export type SaveTaskRuntime = {
  tasksRef: { current: SaveTask[] }
  workers: { current: Map<string, Worker> }
  watchdogs: { current: Map<string, ReturnType<typeof setTimeout>> }
  update(fn: (old: SaveTask[]) => SaveTask[]): void
  notify(
    kind: "success" | "warning" | "error" | "info",
    message: string,
    task?: SaveTask
  ): void
  clearWatchdog(id: string): void
  failWorker(id: string, message: string): void
}
