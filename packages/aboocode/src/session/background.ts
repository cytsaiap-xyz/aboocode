import { Log } from "@/util/log"
import { Instance } from "../project/instance"
import fs from "fs/promises"
import path from "path"

export namespace BackgroundTasks {
  const log = Log.create({ service: "session.background" })

  export interface BackgroundTask {
    taskID: string
    sessionID: string
    parentSessionID: string
    description: string
    agentType: string
    promise: Promise<string>
    status: "running" | "completed" | "failed"
    result?: string
    error?: string
    startTime: number
    endTime?: number
  }

  const state = Instance.state(() => {
    const tasks: Record<string, BackgroundTask> = {}
    return tasks
  })

  /**
   * Register a background task. The promise should resolve to the task output string.
   */
  export function register(input: {
    taskID: string
    sessionID: string
    parentSessionID: string
    description: string
    agentType: string
    promise: Promise<string>
  }): void {
    const task: BackgroundTask = {
      taskID: input.taskID,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      description: input.description,
      agentType: input.agentType,
      promise: input.promise,
      status: "running",
      startTime: Date.now(),
    }

    state()[input.taskID] = task

    // Monitor the promise for completion
    input.promise
      .then(async (result) => {
        task.status = "completed"
        task.result = result
        task.endTime = Date.now()
        log.info("background task completed", { taskID: input.taskID })

        // Write output to file
        await writeOutput(input.taskID, input.sessionID, result)
      })
      .catch(async (error) => {
        task.status = "failed"
        task.error = error?.message ?? String(error)
        task.endTime = Date.now()
        log.error("background task failed", { taskID: input.taskID, error: task.error })

        await writeOutput(input.taskID, input.sessionID, `ERROR: ${task.error}`)
      })
  }

  /**
   * Drain completed/failed background tasks for a parent session.
   * Returns tasks that have finished since the last drain. Removes them from the registry.
   */
  export function drain(parentSessionID: string): BackgroundTask[] {
    const tasks = state()
    const completed: BackgroundTask[] = []

    for (const [id, task] of Object.entries(tasks)) {
      if (task.parentSessionID !== parentSessionID) continue
      if (task.status === "running") continue
      completed.push(task)
      delete tasks[id]
    }

    return completed
  }

  /**
   * Get a background task by ID.
   */
  export function get(taskID: string): BackgroundTask | undefined {
    return state()[taskID]
  }

  /**
   * Kill a background task (mark as failed, does not abort the underlying promise).
   */
  export function kill(taskID: string): boolean {
    const task = state()[taskID]
    if (!task || task.status !== "running") return false
    // Cancel the session prompt loop, which aborts the underlying LLM stream
    import("./prompt").then(({ SessionPrompt }) => {
      SessionPrompt.cancel(task.sessionID)
    }).catch((e) => {
      log.error("failed to cancel background session", { taskID, error: e })
    })
    task.status = "failed"
    task.error = "Task killed by user"
    task.endTime = Date.now()
    delete state()[taskID]
    return true
  }

  /**
   * List all running background tasks for a parent session.
   */
  export function listRunning(parentSessionID: string): BackgroundTask[] {
    return Object.values(state()).filter(
      (t) => t.parentSessionID === parentSessionID && t.status === "running",
    )
  }

  async function writeOutput(taskID: string, sessionID: string, content: string): Promise<void> {
    try {
      const dir = path.join(Instance.directory, ".aboocode", "tasks", sessionID)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${taskID}.md`), content, "utf-8")
    } catch (e) {
      log.error("failed to write background task output", { taskID, error: e })
    }
  }
}
