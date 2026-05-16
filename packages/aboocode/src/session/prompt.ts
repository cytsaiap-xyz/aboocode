import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import { HookLifecycle } from "../hook/lifecycle"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $, fileURLToPath, pathToFileURL } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@aboocode/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncation"
import { Transition } from "./transition"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export class PromptCancelledError extends Error {
  constructor(public readonly sessionID: string) {
    super(`Prompt cancelled by hook for session ${sessionID}`)
    this.name = "PromptCancelledError"
  }
}

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(reason?: any): void
          }[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
      }
    },
  )

  export function assertNotBusy(sessionID: string) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    // Fire prompt.submit hook — plugins can modify or cancel user input
    const textPart = input.parts?.find((p): p is { type: "text"; text: string } => p.type === "text")
    if (textPart) {
      const submitResult = await Plugin.trigger(
        "prompt.submit",
        { sessionID: input.sessionID, text: textPart.text },
        { text: textPart.text, cancel: false },
      )
      if (submitResult.cancel) {
        log.info("prompt cancelled by hook", { sessionID: input.sessionID })
        throw new PromptCancelledError(input.sessionID)
      }
      textPart.text = submitResult.text
      // Phase 2: UserPromptSubmit lifecycle hook (Claude-Code-compatible).
      // Hooks may block the prompt (throws PromptCancelledError) or rewrite it.
      const userDecision = await HookLifecycle.dispatch({
        event: "UserPromptSubmit",
        sessionID: input.sessionID,
        cwd: Instance.directory,
        timestamp: Date.now(),
        prompt: textPart.text,
      })
      if (userDecision.decision === "block") {
        log.info("prompt blocked by UserPromptSubmit hook", {
          sessionID: input.sessionID,
          reason: userDecision.reason,
        })
        throw new PromptCancelledError(input.sessionID)
      }
      if (userDecision.decision === "modify" && typeof userDecision.modified === "string") {
        textPart.text = userDecision.modified
      }
      // Phase 11: hooks may inject `<system-reminder>` snippets via
      // `hookSpecificOutput.additionalContext`. Prepend them to the user
      // text so the next turn sees them as soft instructions.
      const additional = userDecision.hookSpecificOutput?.additionalContext
      if (additional && additional.trim()) {
        textPart.text = `<system-reminder>\n${additional.trim()}\n</system-reminder>\n\n${textPart.text}`
      }

      // Phase 13.6: auto-skill activation. Scan the prompt for keywords
      // matching any registered skill; if there's a strong match, surface
      // it as a `<system-reminder>` advisory. The model can then choose
      // to invoke the skill via the Skill tool. Failure is non-fatal.
      try {
        const { AutoActivate } = await import("@/skill/auto-activate")
        const reminder = await AutoActivate.buildReminder(textPart.text)
        if (reminder) {
          textPart.text = `<system-reminder>\n${reminder}\n</system-reminder>\n\n${textPart.text}`
        }
      } catch (e) {
        log.warn("auto-skill activation failed", { error: e })
      }

      // Team mailbox auto-inject: if this session is part of a team and
      // the agent has unread mail, surface every unread message as a
      // <system-reminder> on the next turn and mark them read. Failure
      // is non-fatal (e.g., team disbanded, file-system hiccup) — the
      // turn proceeds without the inbox snippet.
      try {
        const { TeamManager } = await import("@/team/manager")
        const { Mailbox } = await import("@/team/mailbox")
        const teamId = await TeamManager.resolveTeamId(input.sessionID)
        if (teamId) {
          const agentId = input.agent ?? "orchestrator"
          const unread = await Mailbox.takeUnread({ teamId, agentId })
          if (unread.length > 0) {
            const formatted = unread
              .map((m) => {
                switch (m.kind) {
                  case "text":
                    return `from=${m.from}: ${m.text}`
                  case "idle":
                    return `from=${m.from} idle status=${m.status}${m.result ? ` — ${m.result}` : ""}`
                  case "plan_approval_request":
                    return `from=${m.from} requests plan approval:\n${m.plan}`
                  case "plan_approval_response":
                    return `from=${m.from} plan approval: approved=${m.approved}${m.feedback ? ` — ${m.feedback}` : ""}`
                  case "shutdown_request":
                    return `from=${m.from} requests shutdown: ${m.reason}`
                  case "shutdown_response":
                    return `from=${m.from} shutdown response: approved=${m.approved}${m.reason ? ` — ${m.reason}` : ""}`
                }
              })
              .join("\n")
            textPart.text = `<system-reminder>\nNew teammate messages (${unread.length}):\n${formatted}\n</system-reminder>\n\n${textPart.text}`
          }
        }
      } catch (e) {
        log.warn("mailbox auto-inject failed", { error: e })
      }
    }

    const message = await createUserMessage(input)
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.setPermission({ sessionID: session.id, permission: permissions })
    }

    if (input.noReply === true) {
      return message
    }

    return loop({ sessionID: input.sessionID })
  })

  export async function resolvePromptParts(
    template: string,
    options?: { sessionID?: string },
  ): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    // Use isolation-aware root when a session context is provided
    const effectiveRoot = options?.sessionID
      ? (await import("../agent/isolation-path")).IsolationPath.root(options.sessionID)
      : Instance.worktree
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(effectiveRoot, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  function start(sessionID: string) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  function resume(sessionID: string) {
    const s = state()
    if (!s[sessionID]) return

    return s[sessionID].abort.signal
  }

  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    if (!match) {
      SessionStatus.set(sessionID, { type: "idle" })
      return
    }
    match.abort.abort()
    delete s[sessionID]
    SessionStatus.set(sessionID, { type: "idle" })
    return
  }

  export const LoopInput = z.object({
    sessionID: Identifier.schema("session"),
    resume_existing: z.boolean().optional(),
  })
  export const loop = fn(LoopInput, async (input) => {
    const { sessionID, resume_existing } = input

    const abort = resume_existing ? resume(sessionID) : start(sessionID)
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID].callbacks
        callbacks.push({ resolve, reject })
      })
    }

    using _ = defer(() => cancel(sessionID))

    // Fire session.start hook
    const session = await Session.get(sessionID)
    let sessionAgent = "build" // Refined to lastUser.agent once known
    await Plugin.trigger(
      "session.start",
      { sessionID, agent: sessionAgent, isResume: !!resume_existing },
      {},
    )

    // Structured output state
    // Note: On session resumption, state is reset but outputFormat is preserved
    // on the user message and will be retrieved from lastUser below
    let structuredOutput: unknown | undefined

    let step = 0
    let outputRecoveryAttempts = 0
    let compactRetries = 0
    let terminalReason: Transition.Terminal["reason"] = "completed"
    const { HarnessTrace } = await import("./harness-trace")
    await HarnessTrace.loopStart(sessionID, sessionAgent, "pending")
    while (true) {
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) {
        terminalReason = "aborted_streaming"
        break
      }
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      sessionAgent = lastUser.agent ?? sessionAgent
      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id
      ) {
        log.info("exiting loop", { sessionID, reason: "completed" })
        terminalReason = "completed"
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })
      // Separate subtask and compaction tasks
      const subtaskParts = tasks.filter((t): t is MessageV2.SubtaskPart => t.type === "subtask")
      const compactionParts = tasks.filter((t): t is MessageV2.CompactionPart => t.type === "compaction")

      // Process compaction first (always sequential)
      if (compactionParts.length > 0) {
        const task = compactionParts[0]
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
        })
        if (result === "stop") {
          terminalReason = "completed"
          break
        }
        continue
      }

      // Process subtasks - run multiple concurrently if available
      if (subtaskParts.length > 0) {
        const executeSubtask = async (task: MessageV2.SubtaskPart) => {
          const taskTool = await TaskTool.init()
          const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
          const assistantMessage = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: lastUser!.id,
            sessionID,
            mode: task.agent,
            agent: task.agent,
            variant: lastUser!.variant,
            path: {
              cwd: Instance.directory,
              root: Instance.worktree,
            },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: taskModel.id,
            providerID: taskModel.providerID,
            time: {
              created: Date.now(),
            },
          })) as MessageV2.Assistant
          let part = (await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistantMessage.id,
            sessionID: assistantMessage.sessionID,
            type: "tool",
            callID: ulid(),
            tool: TaskTool.id,
            state: {
              status: "running",
              input: {
                prompt: task.prompt,
                description: task.description,
                subagent_type: task.agent,
                command: task.command,
              },
              time: {
                start: Date.now(),
              },
            },
          })) as MessageV2.ToolPart
          const taskArgs = {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          }
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: "task",
              sessionID,
              callID: part.id,
            },
            { args: taskArgs },
          )
          let executionError: Error | undefined
          const taskAgent = await Agent.get(task.agent)
          const taskCtx: Tool.Context = {
            agent: task.agent,
            messageID: assistantMessage.id,
            sessionID: sessionID,
            abort,
            callID: part.callID,
            extra: { bypassAgentCheck: true },
            messages: msgs,
            async metadata(input) {
              await Session.updatePart({
                ...part,
                type: "tool",
                state: {
                  ...part.state,
                  ...input,
                },
              } satisfies MessageV2.ToolPart)
            },
            async ask(req) {
              await PermissionNext.ask({
                ...req,
                sessionID: sessionID,
                ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
              })
            },
          }
          const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
            executionError = error
            log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
            return undefined
          })
          const attachments = result?.attachments?.map((attachment) => ({
            ...attachment,
            id: Identifier.ascending("part"),
            sessionID,
            messageID: assistantMessage.id,
          }))
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: "task",
              sessionID,
              callID: part.id,
              args: taskArgs,
            },
            result,
          )
          assistantMessage.finish = "tool-calls"
          assistantMessage.time.completed = Date.now()
          await Session.updateMessage(assistantMessage)
          if (result && part.state.status === "running") {
            await Session.updatePart({
              ...part,
              state: {
                status: "completed",
                input: part.state.input,
                title: result.title,
                metadata: result.metadata,
                output: result.output,
                attachments,
                time: {
                  ...part.state.time,
                  end: Date.now(),
                },
              },
            } satisfies MessageV2.ToolPart)
          }
          if (!result) {
            await Session.updatePart({
              ...part,
              state: {
                status: "error",
                error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
                time: {
                  start: part.state.status === "running" ? part.state.time.start : Date.now(),
                  end: Date.now(),
                },
                metadata: part.metadata,
                input: part.state.input,
              },
            } satisfies MessageV2.ToolPart)
          }

          if (task.command) {
            const summaryUserMsg: MessageV2.User = {
              id: Identifier.ascending("message"),
              sessionID,
              role: "user",
              time: {
                created: Date.now(),
              },
              agent: lastUser!.agent,
              model: lastUser!.model,
            }
            await Session.updateMessage(summaryUserMsg)
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: summaryUserMsg.id,
              sessionID,
              type: "text",
              text: "Summarize the task tool output above and continue with your task.",
              synthetic: true,
            } satisfies MessageV2.TextPart)
          }
        }

        // Run subtasks: single => await, multiple => concurrent via Promise.allSettled
        if (subtaskParts.length === 1) {
          await executeSubtask(subtaskParts[0])
        } else {
          log.info("executing subtasks concurrently", { count: subtaskParts.length, sessionID })
          await Promise.allSettled(subtaskParts.map((task) => executeSubtask(task)))
        }
        continue
      }

      // Phase 3 integration: tiered compaction strategy selector. Runs
      // BEFORE the existing microCompact/isOverflow path so cheaper
      // strategies (snip/reactive) get a chance before full summarization.
      if (lastFinished?.tokens && lastFinished.summary !== true) {
        try {
          const { CompactionStrategies } = await import("./compaction-strategies")
          const snapshot = await CompactionStrategies.budget({
            tokens: lastFinished.tokens,
            model,
          })
          const strategy = await CompactionStrategies.selectStrategy(snapshot)
          if (strategy !== "none" && strategy !== "summarize") {
            await CompactionStrategies.run({
              sessionID,
              strategy,
              budget: snapshot,
            })
          }
        } catch (e) {
          log.warn("tiered compaction selector failed", { error: e })
        }
      }

      // Phase 0: Micro-compact old tool results before building model messages
      await SessionCompaction.microCompact({ sessionID })

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // Drain completed background tasks and inject notifications
      const { BackgroundTasks } = await import("./background")
      const bgCompleted = BackgroundTasks.drain(sessionID)
      if (bgCompleted.length > 0) {
        for (const bgTask of bgCompleted) {
          const notifyMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await Session.updateMessage(notifyMsg)
          const statusText = bgTask.status === "completed" ? "completed" : "failed"
          const resultText = bgTask.result ?? bgTask.error ?? "(no output)"
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: notifyMsg.id,
            sessionID,
            type: "text",
            text: `<task-notification>\n<task-id>${bgTask.taskID}</task-id>\nBackground task "${bgTask.description}" (@${bgTask.agentType}) ${statusText}.\nOutput file: .aboocode/tasks/${bgTask.sessionID}/${bgTask.taskID}.md\n\n<result>\n${resultText.slice(0, 2000)}\n</result>\n</task-notification>`,
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }
        // Reload messages so the model sees the injected notifications
        msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
      }

      // normal processing
      const agent = await Agent.get(lastUser.agent)
      if (!agent) throw new Error(`Agent "${lastUser.agent}" not found. It may have been removed or renamed.`)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })

      // Resolve isolation context for this session (if spawned by task tool)
      const { AgentIsolation } = await import("../agent/isolation")
      const sessionIsolation = AgentIsolation.get(sessionID)
      const effectiveCwd = sessionIsolation?.cwd ?? Instance.directory
      const effectiveRoot = sessionIsolation?.root ?? Instance.worktree

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: effectiveCwd,
            root: effectiveRoot,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
      })

      // Inject StructuredOutput tool if JSON schema mode enabled
      if (lastUser.format?.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: lastUser.format.schema,
          onSuccess(output) {
            structuredOutput = output
          },
        })
      }

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of msgs) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

      // Proactive token budget check — trigger compaction before hitting limits
      const { TokenBudget } = await import("./token-budget")
      const budget = await TokenBudget.fromModel(model)
      const modelMessages = MessageV2.toModelMessages(msgs, model)
      budget.currentEstimate = TokenBudget.estimate(modelMessages)
      TokenBudget.logStatus(budget)
      // Publish budget state in session status so UI/API can observe it
      SessionStatus.set(sessionID, {
        type: "busy",
        budget: {
          currentEstimate: budget.currentEstimate,
          maxInputTokens: budget.maxInputTokens,
          percentage: budget.maxInputTokens > 0 ? Math.round((budget.currentEstimate / budget.maxInputTokens) * 100) : 0,
        },
      })
      if (TokenBudget.shouldReactiveCompact(budget)) {
        log.info("reactive compaction triggered by token budget", { sessionID })
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }
      if (TokenBudget.shouldCompact(budget) && !lastFinished?.summary) {
        log.info("proactive compaction triggered by token budget", { sessionID })
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // Build system prompt, adding structured output instruction if needed
      const memoryContext = await (async () => {
        try {
          const { Memory } = await import("../memory")
          // Phase 1 integration: prefer the new memdir-style system prompt
          // (full 4-type taxonomy, team/private dispatch, freshness guidance)
          // with a fallback to the legacy buildContext for safety.
          //
          // Phase 13.6: pass the agent + memoryScope so agents flagged as
          // `isolated` or `inherit` read from their own memdir partition.
          const memScope = lastUser.agent
            ? (await (async () => {
                try {
                  const { Agent } = await import("../agent/agent")
                  const info = await Agent.get(lastUser.agent)
                  return info?.memoryScope
                } catch {
                  return undefined
                }
              })())
            : undefined
          const memdirPrompt = await Memory.buildSystemPrompt({
            agent: lastUser.agent,
            scope: memScope,
          })
          if (memdirPrompt.length > 0) return memdirPrompt
          return await Memory.buildContext()
        } catch {
          return []
        }
      })()
      // Phase 4 integration: per-session output style appended to the system prompt.
      const outputStyleAddendum = await (async () => {
        try {
          const { OutputStyles } = await import("../format/output-styles")
          const addendum = await OutputStyles.systemPromptAddendum()
          return addendum ? [addendum] : []
        } catch {
          return []
        }
      })()
      // Phase 1 integration: LLM-ranked memory recall for this turn.
      // Asks a small model to pick up to 5 relevant memories based on the
      // latest user message text; silently no-ops on any failure.
      const recallReminders = await (async () => {
        try {
          const { Memory } = await import("../memory")
          const userTextPart = lastUser.parts?.find(
            (p: { type?: string; text?: string }) => p.type === "text",
          ) as { text?: string } | undefined
          const query = userTextPart?.text ?? ""
          if (!query) return []
          const controller = new AbortController()
          const recent = msgs
            .flatMap((m) => m.parts.filter((p) => p.type === "tool").map((p) => (p as { tool: string }).tool))
            .slice(-10)
          const { reminders } = await Memory.recall(query, controller.signal, { recentTools: recent })
          return reminders
        } catch {
          return []
        }
      })()
      // Use cache-boundary-aware prompt split: stable prefix (cacheable) then dynamic suffix
      const promptParts2 = await SystemPrompt.build(model)
      const system = [
        ...promptParts2.prefix,
        ...promptParts2.suffix,
        ...(await InstructionPrompt.system()),
        ...memoryContext,
        ...outputStyleAddendum,
        ...recallReminders,
      ]
      // Phase 3: Inject identity context after compaction
      const identityPrompt = SessionCompaction.buildIdentityPrompt(sessionID)
      if (identityPrompt) {
        system.push(identityPrompt)
        SessionCompaction.clearPostCompaction(sessionID)
      }
      const format = lastUser.format ?? { type: "text" }
      if (format.type === "json_schema") {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      let result: Transition.Result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system,
        messages: [
          ...MessageV2.toModelMessages(msgs, model),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
        model,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
      })

      // If structured output was captured, save it and exit immediately
      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        terminalReason = "structured_output"
        break
      }

      // Check if model finished (finish reason is not "tool-calls" or "unknown")
      const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)

      if (modelFinished && !processor.message.error) {
        if (format.type === "json_schema") {
          processor.message.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: 0,
          }).toObject()
          await Session.updateMessage(processor.message)
          terminalReason = "structured_output_missing"
          break
        }
      }

      // If the model finished (stop/end_turn) but processor returned continue,
      // treat it as a terminal "completed" — the processor only tracks errors/compaction,
      // the finish reason is on the message itself.
      if (modelFinished && result.type === "continue" && result.reason === "tool_use") {
        result = Transition.terminal("completed")
      }

      // Handle typed transition from processor
      await HarnessTrace.processorResult(sessionID, result)
      if (result.type === "terminal") {
        log.info("loop terminal", { reason: result.reason, sessionID })

        // For terminal "completed" or "model_error", run quality gate + stop hook
        if (result.reason === "completed" || result.reason === "model_error" || result.reason === "permission_blocked") {
          // Only run quality gate on non-error stops
          if (result.reason !== "model_error") {
            const { QualityGate } = await import("../hook/quality-gate")
            const gateResult = await QualityGate.evaluate({
              sessionID,
              agent: lastUser.agent,
              reason: processor.message.error ? "error" : "model_done",
            })

            await HarnessTrace.qualityGate(sessionID, gateResult.action, gateResult.message as string | undefined)
            const stopResult = await Plugin.trigger(
              "session.stop",
              { sessionID, agent: lastUser.agent, reason: processor.message.error ? "error" : "model_done" },
              {
                action: (gateResult.action === "block" ? "block" : "proceed") as "proceed" | "block",
                message: gateResult.message as string | undefined,
              },
            )
            await HarnessTrace.stopHook(sessionID, stopResult.action)
            if (stopResult.action === "block" && stopResult.message) {
              const blockMsg: MessageV2.User = {
                id: Identifier.ascending("message"),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: lastUser.model,
              }
              await Session.updateMessage(blockMsg)
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: blockMsg.id,
                sessionID,
                type: "text",
                text: stopResult.message,
                synthetic: true,
              } satisfies MessageV2.TextPart)
              continue // stop_hook_blocking: continue loop
            }
          }
        }

        terminalReason = result.reason
        break
      }

      // Handle continue transitions
      log.info("loop continue", { reason: result.reason, sessionID })

      switch (result.reason) {
        case "reactive_compact": {
          compactRetries++
          await HarnessTrace.compaction(sessionID, compactRetries)
          if (compactRetries > 2) {
            log.error("reactive compaction exhausted", { sessionID, attempts: compactRetries })
            terminalReason = "prompt_too_long"
            break
          }
          await SessionCompaction.create({
            sessionID,
            agent: lastUser.agent,
            model: lastUser.model,
            auto: true,
          })
          continue
        }

        case "max_output_tokens_recovery": {
          outputRecoveryAttempts++
          await HarnessTrace.outputRecovery(sessionID, outputRecoveryAttempts)
          if (outputRecoveryAttempts > 3) {
            log.warn("output recovery exhausted", { sessionID, attempts: outputRecoveryAttempts })
            terminalReason = "completed"
            break
          }
          const continueMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await Session.updateMessage(continueMsg)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: continueMsg.id,
            sessionID,
            type: "text",
            text: "Output limit hit. Continue exactly where you left off.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
          continue
        }

        case "tool_use":
        default:
          continue
      }
      // If we reach here from a break inside the switch, exit the outer loop
      break
    }
    // Fire session.end hook with actual terminal reason
    await HarnessTrace.loopEnd(sessionID, terminalReason)
    await HarnessTrace.sessionEnd(sessionID, sessionAgent, terminalReason)
    await Plugin.trigger(
      "session.end",
      { sessionID, agent: sessionAgent, reason: terminalReason },
      {},
    )
    // Phase 11: dispatch Stop / StopFailure lifecycle hooks. Clean
    // terminations fire Stop; abort, overflow, and structured-output
    // failures fire StopFailure with the reason as the error label.
    {
      const cleanReasons: Transition.Terminal["reason"][] = ["completed", "structured_output"]
      const isClean = cleanReasons.includes(terminalReason)
      if (isClean) {
        await HookLifecycle.dispatch({
          event: "Stop",
          sessionID,
          cwd: Instance.directory,
          timestamp: Date.now(),
          reason: terminalReason,
        })
      } else {
        await HookLifecycle.dispatch({
          event: "StopFailure",
          sessionID,
          cwd: Instance.directory,
          timestamp: Date.now(),
          reason: terminalReason,
          error: `Session ended with terminal reason: ${terminalReason}`,
        })
      }
    }
    SessionCompaction.prune({ sessionID })
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = state()[sessionID]?.callbacks ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  })

  async function lastModel(sessionID: string): Promise<{ providerID: string; modelID: string }> {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    // Subagent sessions inherit the parent's model so a primary's --model flag
    // propagates to delegated work instead of resolving to defaultModel().
    try {
      const session = await Session.get(sessionID)
      if (session.parentID) return await lastModel(session.parentID)
    } catch {
      // session lookup failed — fall through to defaultModel
    }
    return Provider.defaultModel()
  }

  /** @internal Exported for testing */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      messages: input.messages,
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    let registeredTools = await ToolRegistry.tools(
      { modelID: input.model.api.id, providerID: input.model.providerID },
      input.agent,
    )

    // Agent-level tool filtering
    if (input.agent.allowedTools?.length) {
      const allowed = new Set(input.agent.allowedTools)
      registeredTools = registeredTools.filter((t) => allowed.has(t.id))
    }
    if (input.agent.disallowedTools?.length) {
      const disallowed = new Set(input.agent.disallowedTools)
      registeredTools = registeredTools.filter((t) => !disallowed.has(t.id))
    }

    // Agent isolation enforcement: filter tools based on resolved isolation mode
    const { AgentIsolation } = await import("../agent/isolation")
    const isolationMode = AgentIsolation.resolve(input.agent)
    if (isolationMode !== "shared") {
      registeredTools = registeredTools.filter((t) => !AgentIsolation.isToolBlocked(t.id, isolationMode))
    }

    for (const item of registeredTools) {
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          // Phase 2: Lifecycle PreToolUse hook dispatch (Claude-Code-compatible).
          // Hooks may block the call (throws) or modify the args.
          const preDecision = await HookLifecycle.dispatch({
            event: "PreToolUse",
            sessionID: ctx.sessionID,
            cwd: Instance.directory,
            timestamp: Date.now(),
            tool_name: item.id,
            tool_input: args,
          })
          if (preDecision.decision === "block") {
            throw new Error(`Tool ${item.id} blocked by PreToolUse hook: ${preDecision.reason ?? "no reason"}`)
          }
          const effectiveArgs =
            preDecision.decision === "modify" && preDecision.modified !== undefined
              ? (preDecision.modified as typeof args)
              : args
          let result: Awaited<ReturnType<typeof item.execute>>
          try {
            result = await item.execute(effectiveArgs, ctx)
          } catch (e) {
            // Phase 11: PostToolUseFailure lifecycle hook. Fires for any
            // tool error (including AbortError) so hooks can observe
            // failures separately from successful PostToolUse events.
            await HookLifecycle.dispatch({
              event: "PostToolUseFailure",
              sessionID: ctx.sessionID,
              cwd: Instance.directory,
              timestamp: Date.now(),
              tool_name: item.id,
              tool_input: effectiveArgs,
              error: e instanceof Error ? e.message : String(e),
              error_type: e instanceof Error ? e.constructor.name : typeof e,
              is_interrupt: (e instanceof Error && e.name === "AbortError") || ctx.abort.aborted,
            })
            throw e
          }
          const output = {
            ...result,
            attachments: result.attachments?.map((attachment) => ({
              ...attachment,
              id: Identifier.ascending("part"),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
          }
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
              args,
            },
            output,
          )
          // Phase 2: Lifecycle PostToolUse hook dispatch. Decisions here are
          // advisory — the tool has already run; a "block" only prevents the
          // output from being written back to the turn if the caller honors it.
          await HookLifecycle.dispatch({
            event: "PostToolUse",
            sessionID: ctx.sessionID,
            cwd: Instance.directory,
            timestamp: Date.now(),
            tool_name: item.id,
            tool_input: effectiveArgs,
            tool_response: output,
          })
          return output
        },
      })
    }

    for (const [key, item] of Object.entries(await MCP.tools())) {
      const execute = item.execute
      if (!execute) continue

      const transformed = ProviderTransform.schema(input.model, asSchema(item.inputSchema).jsonSchema)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(args, opts)

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        // Phase 2: PreToolUse lifecycle hook for MCP tools.
        const preDecision = await HookLifecycle.dispatch({
          event: "PreToolUse",
          sessionID: ctx.sessionID,
          cwd: Instance.directory,
          timestamp: Date.now(),
          tool_name: key,
          tool_input: args,
        })
        if (preDecision.decision === "block") {
          throw new Error(`MCP tool ${key} blocked by PreToolUse hook: ${preDecision.reason ?? "no reason"}`)
        }
        const effectiveArgs =
          preDecision.decision === "modify" && preDecision.modified !== undefined
            ? (preDecision.modified as typeof args)
            : args

        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        let result: Awaited<ReturnType<typeof execute>>
        try {
          result = await execute(effectiveArgs, opts)
        } catch (e) {
          // Phase 11: PostToolUseFailure for MCP tools.
          await HookLifecycle.dispatch({
            event: "PostToolUseFailure",
            sessionID: ctx.sessionID,
            cwd: Instance.directory,
            timestamp: Date.now(),
            tool_name: key,
            tool_input: effectiveArgs,
            error: e instanceof Error ? e.message : String(e),
            error_type: e instanceof Error ? e.constructor.name : typeof e,
            is_interrupt: (e instanceof Error && e.name === "AbortError") || ctx.abort.aborted,
          })
          throw e
        }

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
            args,
          },
          result,
        )

        // Phase 2: PostToolUse lifecycle hook for MCP tools.
        await HookLifecycle.dispatch({
          event: "PostToolUse",
          sessionID: ctx.sessionID,
          cwd: Instance.directory,
          timestamp: Date.now(),
          tool_name: key,
          tool_input: effectiveArgs,
          tool_response: result,
        })

        const textParts: string[] = []
        const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        return {
          title: "",
          metadata,
          output: truncated.content,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: input.processor.message.id,
          })),
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      tools[key] = item
    }

    return tools
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any),
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput(result) {
        return {
          type: "text",
          value: result.output,
        }
      },
    })
  }

  async function createUserMessage(input: PromptInput) {
    const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))

    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const full =
      !input.variant && agent.variant
        ? await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
        : undefined
    const variant = input.variant ?? (agent.variant && full?.variants?.[agent.variant] ? agent.variant : undefined)

    const info: MessageV2.Info = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: input.agent ?? agent.name,
      model,
      system: input.system,
      format: input.format,
      variant,
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
    const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
      ...part,
      id: part.id ?? Identifier.ascending("part"),
    })

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<Draft<MessageV2.Part>[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: Buffer.from(part.url, "base64url").toString(),
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const s = Filesystem.stat(filepath)

              if (s?.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI).catch(() => [])
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) {
                    limit = end - (offset - 1)
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ReadTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              FileTime.read(input.sessionID, filepath)
              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + (await Filesystem.readBytes(filepath)).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat().map(assign))

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    return {
      info,
      parts,
    }
  }

  async function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info; session: Session.Info }) {
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages

    // Original logic when experimental plan mode is disabled
    if (!Flag.ABOOCODE_EXPERIMENTAL_PLAN_MODE) {
      if (input.agent.name === "plan") {
        userMessage.parts.push({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: PROMPT_PLAN,
          synthetic: true,
        })
      }
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
      if (wasPlan && input.agent.name === "build") {
        userMessage.parts.push({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: BUILD_SWITCH,
          synthetic: true,
        })
      }
      return input.messages
    }

    // New plan mode logic when flag is enabled
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // Switching from plan mode to build mode
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (exists) {
        const part = await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
      return input.messages
    }

    // Entering plan mode
    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    }
    return input.messages
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }

    using _ = defer(() => {
      // If no queued callbacks, cancel (the default)
      const callbacks = state()[input.sessionID]?.callbacks ?? []
      if (callbacks.length === 0) {
        cancel(input.sessionID)
      } else {
        // Otherwise, trigger the session loop to process queued items
        loop({ sessionID: input.sessionID, resume_existing: true }).catch((error) => {
          log.error("session loop failed to resume after shell command", { sessionID: input.sessionID, error })
        })
      }
    })

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }
    const agent = await Agent.get(input.agent)
    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const userMsg: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const cwd = Instance.directory
    const shellEnv = await Plugin.trigger(
      "shell.env",
      { cwd, sessionID: input.sessionID, callID: part.callID },
      { env: {} },
    )
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...shellEnv.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)
    const command = await Command.get(input.command)
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolvePromptParts(template, { sessionID: input.sessionID })
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            // TODO: how can we make task tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (text) {
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return

      const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      return Session.setTitle({ sessionID: input.session.id, title })
    }
  }
}
