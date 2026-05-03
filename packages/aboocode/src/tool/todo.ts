import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { HookLifecycle } from "@/hook/lifecycle"
import { Instance } from "@/project/instance"

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    await Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })

    // Phase 13.6: emit TodoUpdated lifecycle event so external hooks
    // can mirror the todo list (audit trails, dashboards, summary
    // banners). Failure is non-fatal — the todo write already succeeded.
    try {
      const summary = {
        total: params.todos.length,
        pending: params.todos.filter((t) => t.status === "pending").length,
        in_progress: params.todos.filter((t) => t.status === "in_progress").length,
        completed: params.todos.filter((t) => t.status === "completed").length,
      }
      await HookLifecycle.dispatch({
        event: "TodoUpdated",
        sessionID: ctx.sessionID,
        cwd: Instance.directory,
        timestamp: Date.now(),
        todos: params.todos as Array<Record<string, unknown>>,
        summary,
      })
    } catch {
      /* non-fatal */
    }

    return {
      title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
      output: JSON.stringify(params.todos, null, 2),
      metadata: {
        todos: params.todos,
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", {
  description: "Use this tool to read your todo list",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "todoread",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    return {
      title: `${todos.filter((x) => x.status !== "completed").length} todos`,
      metadata: {
        todos,
      },
      output: JSON.stringify(todos, null, 2),
    }
  },
})
