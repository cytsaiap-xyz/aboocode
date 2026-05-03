import z from "zod"
import { Tool } from "./tool"
import { TaskTracker } from "./task-tracker-store"

export const TaskUpdateTool = Tool.define("task_update", {
  description: "Update fields on a tracked task. Set status to 'in_progress' when work begins and 'completed' when done. Use task_output to append output text.",
  parameters: z.object({
    id: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "stopped"]).optional(),
    subject: z.string().optional(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  async execute(params, ctx) {
    const { id, ...patch } = params
    const task = TaskTracker.update(ctx.sessionID, id, patch)
    if (!task) {
      return {
        title: `Task ${id} not found`,
        output: `No task with id ${id}`,
        metadata: { id: "", status: "", updated: false },
      }
    }
    return {
      title: `Updated ${task.id} → ${task.status}`,
      output: `Task ${task.id} is now ${task.status}.\n  subject: ${task.subject}`,
      metadata: { id: task.id, status: task.status, updated: true },
    }
  },
})
