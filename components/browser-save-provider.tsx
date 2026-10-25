"use client"

import { useCallback, useState, type ReactNode } from "react"
import { BrowserSaveContext } from "./browser-save/context"
import { SaveTasksPanel } from "./browser-save/tasks-panel"
import { useSaveTasks } from "./browser-save/use-save-tasks"

export { useBrowserSaves } from "./browser-save/context"
export {
  SaveTasksButton,
  SaveActivityBar,
  SaveFullscreenActivity,
  LiveRecordingIndicator,
} from "./browser-save/activity"
export { LiveRecordButton } from "./browser-save/live-record-button"
export { SaveCapabilityNotice } from "./browser-save/capability-notice"

export function BrowserSaveProvider({ children }: { children: ReactNode }) {
  const [tasksOpen, setTasksOpen] = useState(false)
  const showTasks = useCallback(() => setTasksOpen(true), [])
  const manager = useSaveTasks(showTasks)
  return (
    <BrowserSaveContext.Provider value={{ ...manager, tasksOpen, showTasks }}>
      {children}
      <SaveTasksPanel open={tasksOpen} onOpenChange={setTasksOpen} />
    </BrowserSaveContext.Provider>
  )
}
