import z from "zod"
import { Tool } from "./tool"
import { TaskTracker } from "./task-tracker-store"

export const TaskStopTool = Tool.define("task_stop", {
  description: "Mark a tracked task as stopped (canceled). Use when work is abandoned or preempted. Use task_update with status='completed' for normal completion.",
  parameters: z.object({
    id: z.string(),
    reason: z.string().optional(),
  }),
  async execute(params, ctx) {
    const task = TaskTracker.stop(ctx.sessionID, params.id, params.reason)
    if (!task) {
      return {
        title: `Task ${params.id} not found`,
        output: `No task with id ${params.id}`,
        metadata: { id: "", stopped: false },
      }
    }
    return {
      title: `Stopped ${task.id}`,
      output: `Task ${task.id} marked stopped${params.reason ? ` (reason: ${params.reason})` : ""}.`,
      metadata: { id: task.id, stopped: true },
    }
  },
})
