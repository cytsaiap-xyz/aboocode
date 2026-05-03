import z from "zod"
import { Tool } from "./tool"
import { TaskTracker } from "./task-tracker-store"

export const TaskListTool = Tool.define("task_list", {
  description: "List tracked tasks for the current session. Optionally filter by status.",
  parameters: z.object({
    status: z.enum(["pending", "in_progress", "completed", "stopped"]).optional(),
  }),
  async execute(params, ctx) {
    const tasks = TaskTracker.list(ctx.sessionID, params.status ? { status: params.status } : undefined)
    if (tasks.length === 0) {
      return { title: "No tasks", output: "No tracked tasks.", metadata: { count: 0, ids: [] as string[] } }
    }
    const lines = tasks.map((t) => {
      const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject
      return `${t.id}  [${t.status.padEnd(11)}]  ${label}`
    })
    return {
      title: `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
      output: lines.join("\n"),
      metadata: { count: tasks.length, ids: tasks.map((t) => t.id) },
    }
  },
})
