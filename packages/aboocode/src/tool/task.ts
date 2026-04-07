import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt, PromptCancelledError } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set to true to run this task in the background. You will be notified when it completes. Use when you have independent work to do in parallel.",
    ),
  kill_task_id: z
    .string()
    .optional()
    .describe("Kill a running background task by its task_id. When set, all other parameters are ignored."),
})

export const TaskTool = Tool.define<typeof parameters, { sessionId?: string; model?: { modelID: string; providerID: string }; background?: boolean }>("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      // Handle kill request
      if (params.kill_task_id) {
        const { BackgroundTasks } = await import("../session/background")
        const killed = BackgroundTasks.kill(params.kill_task_id)
        return {
          title: killed ? `Killed: ${params.kill_task_id}` : `Not found: ${params.kill_task_id}`,
          metadata: {},
          output: killed
            ? `Background task ${params.kill_task_id} has been killed.`
            : `No running background task found with id ${params.kill_task_id}. It may have already completed or was never started.`,
        }
      }

      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(params.task_id).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      // Create isolation context for the agent
      const { AgentIsolation } = await import("../agent/isolation")
      const isolationMode = AgentIsolation.resolve(agent)
      const isolationCtx = await AgentIsolation.create(isolationMode, session.id)

      // Register isolation context so prompt.ts can resolve cwd/root
      AgentIsolation.register(session.id, isolationCtx)

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
          isolation: isolationMode,
        },
      })

      const messageID = Identifier.ascending("message")
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt, { sessionID: session.id })

      // Background execution: fire and forget, return immediately
      if (params.run_in_background) {
        if (agent.backgroundCapable === false) {
          return {
            title: `Cannot background: ${agent.name}`,
            metadata: {},
            output: `Agent "${agent.name}" does not support background execution. Run it in the foreground instead.`,
          }
        }
        const { BackgroundTasks } = await import("../session/background")
        const { TaskProgress } = await import("../session/task-progress")

        TaskProgress.started({
          sessionID: session.id,
          parentSessionID: ctx.sessionID,
          agent: agent.name,
          description: params.description,
        })

        const bgPromise = (async () => {
          try {
            const result = await SessionPrompt.prompt({
              messageID,
              sessionID: session.id,
              model: { modelID: model.modelID, providerID: model.providerID },
              agent: agent.name,
              tools: {
                todowrite: false,
                todoread: false,
                ...(hasTaskPermission ? {} : { task: false }),
                ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
              },
              parts: promptParts,
            })
            const text = (result.parts.findLast((x: any) => x.type === "text") as any)?.text ?? ""
            TaskProgress.completed({
              sessionID: session.id,
              parentSessionID: ctx.sessionID,
              agent: agent.name,
              summary: text.slice(0, 500),
            })
            return text
          } catch (e) {
            if (e instanceof PromptCancelledError) {
              TaskProgress.completed({
                sessionID: session.id,
                parentSessionID: ctx.sessionID,
                agent: agent.name,
                summary: "Task cancelled by hook",
              })
              return "Task cancelled by hook"
            }
            TaskProgress.failed({
              sessionID: session.id,
              parentSessionID: ctx.sessionID,
              agent: agent.name,
              error: e instanceof Error ? e.message : String(e),
            })
            throw e
          } finally {
            AgentIsolation.unregister(session.id)
        await isolationCtx.cleanup()
          }
        })()

        BackgroundTasks.register({
          taskID: session.id,
          sessionID: session.id,
          parentSessionID: ctx.sessionID,
          description: params.description,
          agentType: params.subagent_type,
          promise: bgPromise,
        })

        return {
          title: `Background: ${params.description}`,
          metadata: { sessionId: session.id, model, background: true },
          output: [
            `task_id: ${session.id}`,
            `Background task started. You will be notified when it completes.`,
            `Output will be written to .aboocode/tasks/${session.id}/`,
          ].join("\n"),
        }
      }

      // Foreground execution: block until complete
      const { TaskProgress } = await import("../session/task-progress")

      TaskProgress.started({
        sessionID: session.id,
        parentSessionID: ctx.sessionID,
        agent: agent.name,
        description: params.description,
      })

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      try {
        const result = await SessionPrompt.prompt({
          messageID,
          sessionID: session.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: agent.name,
          tools: {
            todowrite: false,
            todoread: false,
            ...(hasTaskPermission ? {} : { task: false }),
            ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
          },
          parts: promptParts,
        })

        const text = (result.parts.findLast((x: any) => x.type === "text") as any)?.text ?? ""

        TaskProgress.completed({
          sessionID: session.id,
          parentSessionID: ctx.sessionID,
          agent: agent.name,
          summary: text.slice(0, 500),
        })

        const output = [
          `task_id: ${session.id} (for resuming to continue this task if needed)`,
          "",
          "<task_result>",
          text,
          "</task_result>",
        ].join("\n")

        return {
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
          },
          output,
        }
      } catch (e) {
        if (e instanceof PromptCancelledError) {
          TaskProgress.completed({
            sessionID: session.id,
            parentSessionID: ctx.sessionID,
            agent: agent.name,
            summary: "Task cancelled by hook",
          })
          return {
            title: `Cancelled: ${params.description}`,
            metadata: { sessionId: session.id, model },
            output: [
              `task_id: ${session.id}`,
              "",
              "<task_result>",
              "Task was cancelled by a prompt.submit hook.",
              "</task_result>",
            ].join("\n"),
          }
        }
        TaskProgress.failed({
          sessionID: session.id,
          parentSessionID: ctx.sessionID,
          agent: agent.name,
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      } finally {
        // Cleanup isolation resources (temp dirs, worktrees)
        AgentIsolation.unregister(session.id)
        await isolationCtx.cleanup()
      }
    },
  }
})
