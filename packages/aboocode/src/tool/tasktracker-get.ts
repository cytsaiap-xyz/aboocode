import z from "zod"
import { Tool } from "./tool"
import { TaskTracker } from "./task-tracker-store"

export const TaskGetTool = Tool.define("task_get", {
  description: "Fetch a tracked task by id. Returns subject, status, output, and timestamps.",
  parameters: z.object({
    id: z.string().describe("Task id returned by task_create / task_list"),
  }),
  async execute(params, ctx) {
    const task = TaskTracker.get(ctx.sessionID, params.id)
    if (!task) {
      return {
        title: `Task ${params.id} not found`,
        output: `No task with id ${params.id}`,
        metadata: { id: "", status: "", found: false },
      }
    }
    return {
      title: `${task.subject} — ${task.status}`,
      output: [
        `id:         ${task.id}`,
        `subject:    ${task.subject}`,
        task.description ? `description: ${task.description}` : null,
        task.activeForm ? `activeForm: ${task.activeForm}` : null,
        `status:     ${task.status}`,
        `created:    ${new Date(task.createdAt).toISOString()}`,
        `updated:    ${new Date(task.updatedAt).toISOString()}`,
        task.completedAt ? `completed:  ${new Date(task.completedAt).toISOString()}` : null,
        task.output ? `\n--- output ---\n${task.output}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { id: task.id, status: task.status, found: true },
    }
  },
})
