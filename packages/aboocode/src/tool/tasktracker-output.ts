import z from "zod"
import { Tool } from "./tool"
import { TaskTracker } from "./task-tracker-store"

export const TaskOutputTool = Tool.define("task_output", {
  description: "Append a chunk of output text to a tracked task. Use this to record progress or a summary of what the task produced.",
  parameters: z.object({
    id: z.string(),
    chunk: z.string().describe("Text to append (will be preceded by a newline if output is non-empty)"),
  }),
  async execute(params, ctx) {
    const task = TaskTracker.appendOutput(ctx.sessionID, params.id, params.chunk)
    if (!task) {
      return {
        title: `Task ${params.id} not found`,
        output: `No task with id ${params.id}`,
        metadata: { id: "", outputLength: 0, appended: false },
      }
    }
    return {
      title: `Appended to ${task.id}`,
      output: `Task ${task.id} output length is now ${task.output.length} chars.`,
      metadata: { id: task.id, outputLength: task.output.length, appended: true },
    }
  },
})
