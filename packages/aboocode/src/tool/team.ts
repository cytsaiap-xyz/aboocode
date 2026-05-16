import z from "zod"
import path from "path"
import fs from "fs/promises"
import { generateObject, type ModelMessage } from "ai"
import { Tool } from "./tool"
import { TeamManager } from "../team/manager"
import { Mailbox } from "../team/mailbox"
import { Agent } from "../agent/agent"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import { Skill } from "../skill/skill"
import { KnowledgeBridge } from "../team/knowledge-bridge"
import { Provider } from "../provider/provider"
import { Log } from "../util/log"
import { UsageLog } from "../usage-log"
import { DebugLog } from "../debug-log"

const log = Log.create({ service: "tool.team" })

// ─── plan_team ───
export const PlanTeamTool = Tool.define<
  z.ZodObject<{ task_summary: z.ZodString }>,
  {}
>("plan_team", {
  description:
    "Initialize team planning for a complex task. Call this first before adding agents. Provide a summary of what the team needs to accomplish.",
  parameters: z.object({
    task_summary: z.string().describe("A clear summary of the overall task the team needs to accomplish"),
  }),
  async execute(args, ctx) {
    UsageLog.record("tool.team", "plan_team", { sessionID: ctx.sessionID, taskSummary: args.task_summary })
    const failure = TeamManager.getFailureState(ctx.sessionID)
    if (failure.count >= TeamManager.MAX_CONSECUTIVE_DELEGATION_FAILURES) {
      const lastReason = failure.lastReason ? `\nLast failure reason: ${failure.lastReason}` : ""
      return {
        title: "Team planning blocked",
        output:
          `STOP — refusing to plan a new team. The previous ${failure.count} delegations all failed.${lastReason}\n\n` +
          "Do NOT call plan_team again. Likely causes:\n" +
          "  • subagents are using a provider/model that crashes on tool-call streaming\n" +
          "  • the team-builder is configured incorrectly for this workload\n\n" +
          "Surface the failure to the user with the reason above and stop. The user can reset the counter by starting a new session.",
        metadata: { circuitBreaker: true, count: failure.count },
      }
    }
    const team = TeamManager.startTeam(ctx.sessionID, args.task_summary)
    return {
      title: "Team Planning Started",
      output: `Team planning initialized.\nTask: ${args.task_summary}\n\nNow use add_agent to create specialized agents for this task. Each agent will be created as a real .md file in .aboocode/agents/ and loaded via hot-reload.`,
      metadata: {},
    }
  },
})

// ─── add_agent ───
export const AddAgentTool = Tool.define("add_agent", {
  description:
    "Add a specialized agent to the team. This writes an agent .md file to .aboocode/agents/ which is automatically loaded via hot-reload. Each agent should have a focused responsibility.",
  parameters: z.object({
    agent_id: z
      .string()
      .describe("Unique identifier for the agent (e.g., 'auth-model-dev'). Used as the filename."),
    name: z.string().describe("Human-readable name for the agent"),
    description: z.string().describe("What this agent specializes in"),
    system_prompt: z.string().describe("Detailed system prompt for the agent explaining its task and approach"),
    role: z
      .enum(["explore", "plan", "verify", "implement"])
      .optional()
      .describe(
        "Agent role that determines workspace permissions. 'explore' and 'plan' get read-only access. 'verify' gets read-only plus bash. 'implement' gets full access. Defaults to 'implement'.",
      ),
    skills: z.array(z.string()).optional().describe("Skill names to assign to this agent"),
  }),
  async execute(args, ctx) {
    UsageLog.record("tool.team", "add_agent", { sessionID: ctx.sessionID, agentId: args.agent_id })
    const team = TeamManager.getTeam(ctx.sessionID)
    if (!team) {
      return {
        title: "Error",
        output: "No team found. Call plan_team first.",
        metadata: {},
      }
    }

    // Build skill content to inject
    let skillContent = ""
    if (args.skills && args.skills.length > 0) {
      const skillEntries: string[] = []
      for (const skillName of args.skills) {
        const skill = await Skill.get(skillName)
        if (skill) {
          skillEntries.push(`### Skill: ${skill.name}\n${skill.content}`)
        }
      }
      if (skillEntries.length > 0) {
        skillContent = "\n\n## Available Skills\n" + skillEntries.join("\n\n")
      }
    }

    // Build knowledge context
    const knowledge = await KnowledgeBridge.loadKnowledgeContext()
    let knowledgeContent = ""
    if (knowledge.length > 0) {
      knowledgeContent = "\n\n## Project Knowledge\n" + knowledge.join("\n\n")
    }

    // Write the agent .md file
    const dirs = await Config.directories()
    const targetDir = dirs[0] // Use first config dir (project-level .aboocode/)
    const agentsDir = path.join(targetDir, "agents")
    await fs.mkdir(agentsDir, { recursive: true })

    const filePath = path.join(agentsDir, `${args.agent_id}.md`)
    const role = args.role ?? "implement"

    // Assign permissions based on agent role
    let permissionBlock: string
    switch (role) {
      case "explore":
      case "plan":
        permissionBlock = [
          "permission:",
          "  read: allow",
          "  glob: allow",
          "  grep: allow",
          "  write: deny",
          "  edit: deny",
          "  bash: deny",
        ].join("\n")
        break
      case "verify":
        permissionBlock = [
          "permission:",
          "  read: allow",
          "  glob: allow",
          "  grep: allow",
          "  bash: allow",
          "  write: deny",
          "  edit: deny",
        ].join("\n")
        break
      case "implement":
      default:
        permissionBlock = [
          "permission:",
          "  read: allow",
          "  write: allow",
          "  edit: allow",
          "  bash: allow",
          "  glob: allow",
          "  grep: allow",
        ].join("\n")
        break
    }

    const content = [
      "---",
      `name: ${args.name}`,
      `description: ${args.description}`,
      "mode: subagent",
      permissionBlock,
      "---",
      args.system_prompt,
      skillContent,
      knowledgeContent,
      "",
      KnowledgeBridge.buildWorkerRecordingInstructions(),
    ].join("\n")

    await fs.writeFile(filePath, content, "utf-8")
    log.info("wrote agent file", { path: filePath })

    // Immediately trigger agent reload so it's available
    await Agent.reload()

    // Verify the agent was loaded
    const loaded = await Agent.get(args.agent_id)
    if (!loaded) {
      return {
        title: "Warning",
        output: `Agent file written to ${filePath} but agent "${args.agent_id}" could not be loaded. Check the file format.`,
        metadata: {},
      }
    }

    // Track in team state
    TeamManager.addAgent(ctx.sessionID, {
      id: args.agent_id,
      name: args.name,
      description: args.description,
      skills: args.skills ?? [],
    })

    return {
      title: `Agent Added: ${args.name}`,
      output: `Agent "${args.name}" (${args.agent_id}) created and loaded successfully.\nFile: ${filePath}\nThe agent is now available in the system.`,
      metadata: {},
    }
  },
})

// ─── finalize_team ───
export const FinalizeTeamTool = Tool.define<z.ZodObject<{}>, {}>("finalize_team", {
  description:
    "Finalize the team after adding all agents. Validates that at least 2 agents exist and confirms they are all loaded. Must be called before delegate_task or delegate_tasks.",
  parameters: z.object({}),
  async execute(_args, ctx) {
    UsageLog.record("tool.team", "finalize_team", { sessionID: ctx.sessionID })
    const team = TeamManager.getTeam(ctx.sessionID)
    if (!team) {
      return {
        title: "Error",
        output: "No team found. Call plan_team first.",
        metadata: {},
      }
    }

    // Verify all agents are loaded
    const missing: string[] = []
    for (const agent of team.pendingAgents) {
      const loaded = await Agent.get(agent.id)
      if (!loaded) {
        missing.push(agent.id)
      }
    }

    if (missing.length > 0) {
      return {
        title: "Error",
        output: `The following agents are not loaded: ${missing.join(", ")}. Check the agent files or call add_agent again.`,
        metadata: {},
      }
    }

    try {
      const agentIds = TeamManager.finalizeTeam(ctx.sessionID)
      return {
        title: "Team Finalized",
        output: `Team finalized with ${agentIds.length} agents: ${agentIds.join(", ")}.\n\nYou can now delegate tasks using delegate_task (sequential) or delegate_tasks (parallel).`,
        metadata: {},
      }
    } catch (e: any) {
      return {
        title: "Error",
        output: e.message,
        metadata: {},
      }
    }
  },
})

// ─── delegate_task ───
export const DelegateTaskTool = Tool.define<
  z.ZodObject<{
    agent_id: z.ZodString
    task: z.ZodString
    run_in_background: z.ZodDefault<z.ZodBoolean>
  }>,
  {}
>("delegate_task", {
  description:
    "Delegate a task to a specific team agent. The agent will execute the task in a child session.\n\nBy default the orchestrator blocks until the task finishes (foreground). Pass run_in_background=true to fire and forget — the call returns immediately with the child session id, the teammate runs in the background, and you'll receive an idle_notification message in your mailbox when it finishes (or fails).",
  parameters: z.object({
    agent_id: z.string().describe("The ID of the agent to delegate to"),
    task: z.string().describe("Detailed description of the task for the agent"),
    run_in_background: z
      .boolean()
      .default(false)
      .describe(
        "If true, return immediately and let the teammate run in the background. Watch the mailbox for an idle_notification when it finishes.",
      ),
  }),
  async execute(args, ctx) {
    UsageLog.record("tool.team", "delegate_task", {
      sessionID: ctx.sessionID,
      agentId: args.agent_id,
      background: args.run_in_background,
    })

    // Validate team is active (must be finalized before delegation)
    const team = TeamManager.getTeam(ctx.sessionID)
    if (!team) {
      return {
        title: "Error",
        output: "No team found. Call plan_team first.",
        metadata: {},
      }
    }
    if (team.status !== "active") {
      return {
        title: "Error",
        output: "Team is not finalized. Call finalize_team before delegating tasks.",
        metadata: {},
      }
    }
    if (!team.activeAgentIds.includes(args.agent_id)) {
      return {
        title: "Error",
        output: `Agent "${args.agent_id}" is not part of the current team. Available agents: ${team.activeAgentIds.join(", ")}`,
        metadata: {},
      }
    }

    const agent = await Agent.get(args.agent_id)
    if (!agent) {
      return {
        title: "Error",
        output: `Agent "${args.agent_id}" not found. Make sure the agent was created with add_agent.`,
        metadata: {},
      }
    }

    DebugLog.teamDelegateTask(ctx.sessionID, args.agent_id, args.task)
    log.info("delegating task", { agent: args.agent_id, task: args.task, background: args.run_in_background })

    // Create child session
    const childSession = await Session.create({
      parentID: ctx.sessionID,
      title: `Team task: ${args.agent_id}`,
    })

    // Background path — return immediately; child session runs detached.
    // When the child finishes (success or failure), we drop an
    // idle_notification on the orchestrator's mailbox so the lead can
    // pick the result up at the start of its next turn.
    if (args.run_in_background) {
      const teamId = TeamManager.teamIdFor(ctx.sessionID)
      void (async () => {
        try {
          const result = await SessionPrompt.prompt({
            sessionID: childSession.id,
            agent: args.agent_id,
            parts: [{ type: "text", text: args.task }],
          })
          const output = result.parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n")
          await Mailbox.send({
            teamId,
            message: {
              kind: "idle",
              from: args.agent_id,
              to: "orchestrator",
              ts: Date.now(),
              read: false,
              status: "resolved",
              result: output || "(No text output)",
              summary: `${args.agent_id} finished`,
            },
          })
          TeamManager.recordDelegation(ctx.sessionID, true)
          DebugLog.teamDelegateTaskDone(ctx.sessionID, args.agent_id, "success", output || "")
        } catch (error: any) {
          TeamManager.recordDelegation(ctx.sessionID, false, error?.message ?? String(error))
          await Mailbox.send({
            teamId,
            message: {
              kind: "idle",
              from: args.agent_id,
              to: "orchestrator",
              ts: Date.now(),
              read: false,
              status: "failed",
              result: error?.message ?? String(error),
              summary: `${args.agent_id} failed`,
            },
          })
          DebugLog.teamDelegateTaskDone(ctx.sessionID, args.agent_id, "error", error?.message ?? String(error))
        }
      })()
      return {
        title: `Backgrounded: ${args.agent_id}`,
        output: `Agent "${args.agent_id}" is running in the background.\nSession: ${childSession.id}\nWatch your mailbox for an idle_notification when it finishes.`,
        // TUI reads `sessionId` (camelCase, lowercase d) to drill into the
        // subagent — must match the `task` tool's metadata shape.
        metadata: { sessionId: childSession.id, agentId: args.agent_id, background: true },
      }
    }

    // Foreground path — block on the result, same as before.
    const onAbort = () => SessionPrompt.cancel(childSession.id)
    ctx.abort.addEventListener("abort", onAbort, { once: true })

    // Execute the task
    try {
      const result = await SessionPrompt.prompt({
        sessionID: childSession.id,
        agent: args.agent_id,
        parts: [{ type: "text", text: args.task }],
      })

      // Extract text from the result
      const output = result.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")

      TeamManager.recordDelegation(ctx.sessionID, true)
      DebugLog.teamDelegateTaskDone(ctx.sessionID, args.agent_id, "success", output || "(No text output)")
      return {
        title: `Task Complete: ${args.agent_id}`,
        output: `Agent "${args.agent_id}" completed the task.\n\nSession: ${childSession.id}\n\n## Result\n${output || "(No text output)"}`,
        metadata: { sessionId: childSession.id, agentId: args.agent_id, background: false },
      }
    } catch (error: any) {
      TeamManager.recordDelegation(ctx.sessionID, false, error.message)
      DebugLog.teamDelegateTaskDone(ctx.sessionID, args.agent_id, "error", error.message)
      return {
        title: `Task Failed: ${args.agent_id}`,
        output: `Agent "${args.agent_id}" failed: ${error.message}`,
        metadata: { sessionId: childSession.id, agentId: args.agent_id, background: false, error: error.message },
      }
    } finally {
      ctx.abort.removeEventListener("abort", onAbort)
    }
  },
})

// ─── delegate_tasks ───
export const DelegateTasksTool = Tool.define<
  z.ZodObject<{
    delegations: z.ZodArray<
      z.ZodObject<{
        agent_id: z.ZodString
        task: z.ZodString
        depends_on: z.ZodOptional<z.ZodArray<z.ZodString>>
      }>
    >
  }>,
  {}
>("delegate_tasks", {
  description:
    "Delegate multiple tasks to team agents concurrently. Tasks without depends_on run in parallel. Tasks with depends_on wait for their dependencies to complete first. Use this when agents work on independent features or files.",
  parameters: z.object({
    delegations: z.array(
      z.object({
        agent_id: z.string().describe("The agent to delegate to"),
        task: z.string().describe("The task description"),
        depends_on: z.array(z.string()).optional().describe("Agent IDs whose tasks must complete first"),
      }),
    ),
  }),
  async execute(args, ctx) {
    UsageLog.record("tool.team", "delegate_tasks", { sessionID: ctx.sessionID, delegationCount: args.delegations.length })

    // Validate team is active (must be finalized before delegation)
    const team = TeamManager.getTeam(ctx.sessionID)
    if (!team) {
      return {
        title: "Error",
        output: "No team found. Call plan_team first.",
        metadata: {},
      }
    }
    if (team.status !== "active") {
      return {
        title: "Error",
        output: "Team is not finalized. Call finalize_team before delegating tasks.",
        metadata: {},
      }
    }
    // Validate all delegated agents are part of the team
    const invalidAgents = args.delegations
      .map((d) => d.agent_id)
      .filter((id) => !team.activeAgentIds.includes(id))
    if (invalidAgents.length > 0) {
      return {
        title: "Error",
        output: `Agents not part of the current team: ${invalidAgents.join(", ")}. Available agents: ${team.activeAgentIds.join(", ")}`,
        metadata: {},
      }
    }

    DebugLog.teamDelegateTasks(ctx.sessionID, args.delegations)
    const maxConcurrent = 5
    const results: Record<string, { status: "success" | "error" | "skipped"; output: string; sessionID?: string }> = {}

    // Build dependency graph
    const taskMap = new Map(args.delegations.map((d) => [d.agent_id, d]))
    const completed = new Set<string>()
    const failed = new Set<string>()
    const skipped = new Set<string>()

    async function executeTask(delegation: { agent_id: string; task: string }) {
      const agent = await Agent.get(delegation.agent_id)
      if (!agent) {
        results[delegation.agent_id] = {
          status: "error",
          output: `Agent "${delegation.agent_id}" not found.`,
        }
        failed.add(delegation.agent_id)
        return
      }

      log.info("parallel: executing task", { agent: delegation.agent_id })

      const childSession = await Session.create({
        parentID: ctx.sessionID,
        title: `Team task: ${delegation.agent_id}`,
      })

      // Propagate parent abort to child
      const onAbort = () => SessionPrompt.cancel(childSession.id)
      ctx.abort.addEventListener("abort", onAbort, { once: true })

      try {
        // Inject context from completed dependencies
        const deps = taskMap.get(delegation.agent_id)?.depends_on ?? []
        let taskText = delegation.task
        if (deps.length > 0) {
          const depResults = deps
            .filter((d) => completed.has(d))
            .map((d) => `### Result from ${d}:\n${results[d]?.output ?? "(no output)"}`)
          if (depResults.length > 0) {
            taskText += "\n\n## Context from prior tasks\n" + depResults.join("\n\n")
          }
        }

        const result = await SessionPrompt.prompt({
          sessionID: childSession.id,
          agent: delegation.agent_id,
          parts: [{ type: "text", text: taskText }],
        })

        const output = result.parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n")

        results[delegation.agent_id] = {
          status: "success",
          output: output || "(No text output)",
          sessionID: childSession.id,
        }
        completed.add(delegation.agent_id)
        TeamManager.recordDelegation(ctx.sessionID, true)
      } catch (error: any) {
        results[delegation.agent_id] = {
          status: "error",
          output: error.message,
          sessionID: childSession.id,
        }
        failed.add(delegation.agent_id)
        TeamManager.recordDelegation(ctx.sessionID, false, error.message)
      } finally {
        ctx.abort.removeEventListener("abort", onAbort)
      }
    }

    // Execute in waves based on dependencies
    const remaining = new Set(args.delegations.map((d) => d.agent_id))

    while (remaining.size > 0) {
      // Skip tasks whose dependencies have failed or been skipped
      const toSkip: string[] = []
      for (const delegation of args.delegations) {
        if (!remaining.has(delegation.agent_id)) continue
        const deps = delegation.depends_on ?? []
        const hasFailedDep = deps.some((d) => failed.has(d) || skipped.has(d))
        if (hasFailedDep) {
          const failedDeps = deps.filter((d) => failed.has(d) || skipped.has(d))
          toSkip.push(delegation.agent_id)
          results[delegation.agent_id] = {
            status: "skipped",
            output: `Skipped: required dependency ${failedDeps.map((d) => `"${d}"`).join(", ")} failed or was skipped. Upstream error: ${failedDeps.map((d) => results[d]?.output ?? "(unknown)").join("; ")}`,
          }
        }
      }
      for (const id of toSkip) {
        skipped.add(id)
        remaining.delete(id)
      }
      if (remaining.size === 0) break

      // Find tasks whose dependencies are all successfully completed
      const ready: typeof args.delegations = []
      for (const delegation of args.delegations) {
        if (!remaining.has(delegation.agent_id)) continue
        const deps = delegation.depends_on ?? []
        const allDepsCompleted = deps.every((d) => completed.has(d))
        if (allDepsCompleted) {
          ready.push(delegation)
        }
      }

      if (ready.length === 0) {
        // Deadlock or all remaining tasks have unresolvable dependencies
        for (const id of remaining) {
          results[id] = {
            status: "error",
            output: "Task could not execute: unresolvable dependency cycle.",
          }
        }
        break
      }

      // Execute ready tasks in batches of maxConcurrent
      for (let i = 0; i < ready.length; i += maxConcurrent) {
        const batch = ready.slice(i, i + maxConcurrent)
        const promises = batch.map((d) => {
          remaining.delete(d.agent_id)
          return executeTask(d)
        })
        await Promise.allSettled(promises)
      }
    }

    DebugLog.teamDelegateTasksDone(ctx.sessionID, results)
    // Format output
    const lines: string[] = [`## Parallel Execution Results (${Object.keys(results).length} tasks)`]
    for (const [agentId, result] of Object.entries(results)) {
      const icon = result.status === "success" ? "[OK]" : "[FAILED]"
      lines.push(`\n### ${icon} ${agentId}`)
      lines.push(result.output)
      if (result.sessionID) lines.push(`Session: ${result.sessionID}`)
    }

    // Expose sessionIds at the top level so the TUI can render a multi-
    // child subagent block without iterating into `results`.
    const sessionIds = Object.values(results)
      .map((r) => r.sessionID)
      .filter((s): s is string => typeof s === "string")
    return {
      title: `Parallel Tasks Complete`,
      output: lines.join("\n"),
      metadata: { results, sessionIds },
    }
  },
})

// ─── list_team ───
export const ListTeamTool = Tool.define<z.ZodObject<{}>, {}>("list_team", {
  description: "List all agents in the current team and their status.",
  parameters: z.object({}),
  async execute(_args, ctx) {
    UsageLog.record("tool.team", "list_team", { sessionID: ctx.sessionID })
    const team = TeamManager.getTeam(ctx.sessionID)
    if (!team) {
      return {
        title: "No Team",
        output: "No active team. Use plan_team to start one.",
        metadata: {},
      }
    }

    const agents = TeamManager.listTeam(ctx.sessionID)
    const lines = [
      `Team Status: ${team.status}`,
      `Task: ${team.taskSummary}`,
      `Agents (${agents.length}):`,
      ...agents.map((a) => `- ${a.id}: ${a.name} - ${a.description}${a.skills.length ? ` [skills: ${a.skills.join(", ")}]` : ""}`),
    ]

    return {
      title: "Team Status",
      output: lines.join("\n"),
      metadata: {},
    }
  },
})

// ─── disband_team ───
export const DisbandTeamTool = Tool.define<z.ZodObject<{}>, {}>("disband_team", {
  description:
    "Disband the team and delete all dynamically-created agent files. Call this when the team's work is complete.",
  parameters: z.object({}),
  async execute(_args, ctx) {
    UsageLog.record("tool.team", "disband_team", { sessionID: ctx.sessionID })
    const team = TeamManager.getTeam(ctx.sessionID)
    if (!team) {
      return {
        title: "No Team",
        output: "No active team to disband.",
        metadata: {},
      }
    }

    const agents = team.pendingAgents
    const deleted: string[] = []
    const dirs = await Config.directories()

    // Delete agent .md files
    for (const agent of agents) {
      for (const dir of dirs) {
        const filePath = path.join(dir, "agents", `${agent.id}.md`)
        try {
          await fs.unlink(filePath)
          deleted.push(filePath)
          log.info("deleted agent file", { path: filePath })
        } catch {
          // File might not exist in this directory
        }
      }
    }

    // Reload agents to pick up deletions
    await Agent.reload()

    // Clean up team state — pass deleted files to debug log
    DebugLog.teamDisbanded(ctx.sessionID, deleted)
    TeamManager.disbandTeam(ctx.sessionID)

    return {
      title: "Team Disbanded",
      output: `Team disbanded. ${deleted.length} agent files deleted:\n${deleted.map((f) => `- ${f}`).join("\n")}\n\nAll team agents have been removed from the system.`,
      metadata: { deleted },
    }
  },
})

// ─── discuss ───

interface TranscriptEntry {
  agent_id: string
  name: string
  content: string
  round: number
}

const ModeratorDecisionSchema = z.object({
  action: z.enum(["continue", "conclude"]),
  next_agent_id: z.string().optional(),
  prompt_for_agent: z.string().optional(),
  reasoning: z.string(),
  summary: z.string().optional(),
  key_points: z.array(z.string()).optional(),
})

type ModeratorDecision = z.infer<typeof ModeratorDecisionSchema>

const MODERATOR_PROMPT = `You are a discussion moderator facilitating a collaborative conversation between specialized agents.

Your job is to:
1. Review the discussion transcript so far
2. Decide who should speak next based on relevance, expertise, and recency (avoid having the same agent speak twice in a row)
3. Provide a focused prompt/question for the next speaker to address
4. Conclude the discussion when: consensus is reached, all perspectives have been explored, or agents are repeating themselves

When concluding, provide a clear summary of the discussion and key points/decisions reached.

If this is the first round, pick the agent whose expertise is most relevant to the topic to speak first.`

async function moderatorDecide(input: {
  topic: string
  agents: { id: string; name: string; description: string }[]
  transcript: TranscriptEntry[]
  round: number
  maxRounds: number
  forceConclude?: boolean
}): Promise<ModeratorDecision> {
  const defaultModel = await Provider.defaultModel()
  const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
  const language = await Provider.getLanguage(model)

  const agentList = input.agents.map((a) => `- ${a.id} (${a.name}): ${a.description}`).join("\n")

  const transcriptText =
    input.transcript.length > 0
      ? input.transcript.map((t) => `[Round ${t.round}] ${t.name} (${t.agent_id}):\n${t.content}`).join("\n\n")
      : "(No discussion yet — this is the opening round)"

  const userContent = [
    `## Topic\n${input.topic}`,
    `## Available Agents\n${agentList}`,
    `## Transcript\n${transcriptText}`,
    `## Status\nRound ${input.round} of ${input.maxRounds}`,
    input.forceConclude
      ? "\n## INSTRUCTION: Maximum rounds reached. You MUST conclude the discussion now. Set action to \"conclude\" and provide a summary and key_points."
      : "",
  ].join("\n\n")

  const result = await generateObject({
    temperature: 0.3,
    messages: [
      { role: "system", content: MODERATOR_PROMPT } as ModelMessage,
      { role: "user", content: userContent } as ModelMessage,
    ],
    model: language,
    schema: ModeratorDecisionSchema,
  })

  return result.object
}

async function agentSpeak(input: {
  agentId: string
  topic: string
  prompt: string
  transcript: TranscriptEntry[]
  sessionID: string
  abort: AbortSignal
}): Promise<string> {
  const childSession = await Session.create({
    parentID: input.sessionID,
    title: `Discussion: ${input.agentId}`,
  })

  const onAbort = () => SessionPrompt.cancel(childSession.id)
  input.abort.addEventListener("abort", onAbort, { once: true })

  try {
    const transcriptContext =
      input.transcript.length > 0
        ? input.transcript.map((t) => `**${t.name}** (round ${t.round}):\n${t.content}`).join("\n\n")
        : ""

    const taskText = [
      `## Discussion Topic\n${input.topic}`,
      transcriptContext ? `## Discussion So Far\n${transcriptContext}` : "",
      `## Your Turn\n${input.prompt}`,
      "\nProvide your perspective concisely. Build on what others have said. Be specific and actionable.",
    ]
      .filter(Boolean)
      .join("\n\n")

    const result = await SessionPrompt.prompt({
      sessionID: childSession.id,
      agent: input.agentId,
      parts: [{ type: "text", text: taskText }],
    })

    return result.parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n")
  } catch (error: any) {
    return `(Agent failed to respond: ${error.message})`
  } finally {
    input.abort.removeEventListener("abort", onAbort)
  }
}

function formatConclusion(input: {
  topic: string
  summary: string
  keyPoints: string[]
  transcript: TranscriptEntry[]
  rounds: number
}): string {
  const lines: string[] = []

  lines.push(`## Discussion Conclusion`)
  lines.push(`**Topic:** ${input.topic}`)
  lines.push(`**Rounds:** ${input.rounds}`)
  lines.push("")
  lines.push(`### Summary`)
  lines.push(input.summary)
  lines.push("")

  if (input.keyPoints.length > 0) {
    lines.push(`### Key Points`)
    for (const point of input.keyPoints) {
      lines.push(`- ${point}`)
    }
    lines.push("")
  }

  lines.push(`### Full Transcript`)
  for (const entry of input.transcript) {
    lines.push(`\n**[Round ${entry.round}] ${entry.name}:**`)
    lines.push(entry.content)
  }

  return lines.join("\n")
}

export const DiscussTool = Tool.define<
  z.ZodObject<{
    topic: z.ZodString
    agents: z.ZodArray<z.ZodString>
    max_rounds: z.ZodOptional<z.ZodNumber>
  }>,
  {}
>("discuss", {
  description:
    "Start a moderated discussion between team agents. The orchestrator acts as moderator, dynamically choosing who speaks next based on the conversation. Use this for collaborative deliberation before implementation — architecture decisions, design reviews, trade-off analysis.",
  parameters: z.object({
    topic: z.string().describe("The topic or question for the agents to discuss"),
    agents: z.array(z.string()).min(2).describe("Agent IDs to participate in the discussion"),
    max_rounds: z
      .number()
      .int()
      .min(2)
      .max(10)
      .optional()
      .describe("Maximum discussion rounds (default 5, max 10)"),
  }),
  async execute(args, ctx) {
    UsageLog.record("tool.team", "discuss", { sessionID: ctx.sessionID, topic: args.topic, agentCount: args.agents.length })
    const maxRounds = args.max_rounds ?? 5

    // Validate team is active
    const team = TeamManager.getTeam(ctx.sessionID)
    if (!team) {
      return {
        title: "Error",
        output: "No team found. Call plan_team first.",
        metadata: {},
      }
    }
    if (team.status !== "active") {
      return {
        title: "Error",
        output: "Team is not finalized. Call finalize_team before starting a discussion.",
        metadata: {},
      }
    }

    // Validate all agents exist
    const agentInfos: { id: string; name: string; description: string }[] = []
    for (const agentId of args.agents) {
      const agent = await Agent.get(agentId)
      if (!agent) {
        return {
          title: "Error",
          output: `Agent "${agentId}" not found. Make sure the agent was created with add_agent.`,
          metadata: {},
        }
      }
      agentInfos.push({ id: agentId, name: agent.name, description: agent.description ?? "" })
    }

    DebugLog.teamDiscuss(ctx.sessionID, args.topic, args.agents)
    log.info("starting discussion", { topic: args.topic, agents: args.agents, maxRounds })

    const transcript: TranscriptEntry[] = []
    let round = 1

    while (round <= maxRounds) {
      // Ask moderator who speaks next (or conclude)
      const decision = await moderatorDecide({
        topic: args.topic,
        agents: agentInfos,
        transcript,
        round,
        maxRounds,
        forceConclude: round > maxRounds,
      })

      if (decision.action === "conclude") {
        DebugLog.teamDiscussDone(ctx.sessionID, round - 1, decision.summary ?? "Discussion concluded.")
        return {
          title: "Discussion Complete",
          output: formatConclusion({
            topic: args.topic,
            summary: decision.summary ?? "Discussion concluded.",
            keyPoints: decision.key_points ?? [],
            transcript,
            rounds: round - 1,
          }),
          metadata: { rounds: round - 1, participants: args.agents },
        }
      }

      // Validate next_agent_id
      let nextAgentId = decision.next_agent_id
      if (!nextAgentId || !args.agents.includes(nextAgentId)) {
        // Fallback: pick least-recently-speaking agent
        const speakCounts = new Map<string, number>()
        for (const id of args.agents) speakCounts.set(id, 0)
        for (const entry of transcript) {
          speakCounts.set(entry.agent_id, (speakCounts.get(entry.agent_id) ?? 0) + 1)
        }
        nextAgentId = args.agents.reduce((a, b) => ((speakCounts.get(a) ?? 0) <= (speakCounts.get(b) ?? 0) ? a : b))
      }

      const nextAgent = agentInfos.find((a) => a.id === nextAgentId)!
      const prompt = decision.prompt_for_agent ?? `Share your perspective on: ${args.topic}`

      log.info("discussion turn", { round, agent: nextAgentId, prompt })

      // Agent speaks
      const response = await agentSpeak({
        agentId: nextAgentId,
        topic: args.topic,
        prompt,
        transcript,
        sessionID: ctx.sessionID,
        abort: ctx.abort,
      })

      transcript.push({
        agent_id: nextAgentId,
        name: nextAgent.name,
        content: response,
        round,
      })

      round++
    }

    // Force conclude at max rounds
    const finalDecision = await moderatorDecide({
      topic: args.topic,
      agents: agentInfos,
      transcript,
      round,
      maxRounds,
      forceConclude: true,
    })

    DebugLog.teamDiscussDone(ctx.sessionID, maxRounds, finalDecision.summary ?? "Discussion concluded after reaching maximum rounds.")
    return {
      title: "Discussion Complete",
      output: formatConclusion({
        topic: args.topic,
        summary: finalDecision.summary ?? "Discussion concluded after reaching maximum rounds.",
        keyPoints: finalDecision.key_points ?? [],
        transcript,
        rounds: maxRounds,
      }),
      metadata: { rounds: maxRounds, participants: args.agents },
    }
  },
})
