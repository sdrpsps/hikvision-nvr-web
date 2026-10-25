import { createSaveTask, type SaveWorkerScope } from "./runner"

const scope = self as unknown as SaveWorkerScope
let task: ReturnType<typeof createSaveTask> | undefined
let stoppedBeforeStart = false
scope.onmessage = (event) => {
  if (event.data.type === "stop") {
    if (task) task.stop()
    else stoppedBeforeStart = true
  } else if (!task) {
    task = createSaveTask(event.data, scope, stoppedBeforeStart)
    scope.postMessage({ type: "ready", patch: {} })
    void task.run()
  }
}
