"use client"

import { createContext, useContext } from "react"
import type { SaveSource, SaveTask } from "@/lib/browser-save/types"

export const BrowserSaveContext = createContext<{
  tasks: SaveTask[]
  tasksOpen: boolean
  start(source: SaveSource): Promise<void>
  stop(id: string): void
  dismiss(id: string): void
  showTasks(): void
}>({
  tasks: [],
  tasksOpen: false,
  start: async () => {},
  stop: () => {},
  dismiss: () => {},
  showTasks: () => {},
})

export function useBrowserSaves() {
  return useContext(BrowserSaveContext)
}
