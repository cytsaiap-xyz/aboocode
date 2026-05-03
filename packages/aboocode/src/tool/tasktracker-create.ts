import z from "zod"
import { Tool } from "./tool"
import { TaskTracker } from "./task-tracker-store"

export const TaskCreateTool = Tool.define("task_create", {
  description: `Create a new tracked task. Use this to announce work-in-progress so the user can see what you're doing and so you can update status as you go.

Each task carries: subject (short imperative), optional description, optional activeForm (present-continuous label shown while running), and status (starts 'pending').

Use when you are about to do a multi-step piece of work — this is complementary to TodoWrite: TodoWrite is a checklist for the user, TaskCreate/Update is the agent's own work log.`,
  parameters: z.object({
    subject: z.string().describe("Brief imperative title (e.g. 'Run integration tests')"),
    description: z.string().optional().describe("Longer explanation"),
    activeForm: z.string().optional().describe("Present-continuous form shown while running (e.g. 'Running integration tests')"),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  async execute(params, ctx) {
    const task = TaskTracker.create({
      sessionID: ctx.sessionID,
      subject: params.subject,
      description: params.description,
      activeForm: params.activeForm,
      metadata: params.metadata,
    })
    return {
      title: `Created task ${task.id}`,
      output: `Task ${task.id} created (status: ${task.status})\n  subject: ${task.subject}${task.activeForm ? `\n  activeForm: ${task.activeForm}` : ""}`,
      metadata: { id: task.id, status: task.status },
    }
  },
})
