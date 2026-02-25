import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { TeamManager } from "../team/manager"
import { Agent } from "../agent/agent"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import { Skill } from "../skill/skill"
import { KnowledgeBridge } from "../team/knowledge-bridge"
import { Log } from "../util/log"

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
    const team = TeamManager.startTeam(ctx.sessionID, args.task_summary)
    return {
      title: "Team Planning Started",
      output: `Team planning initialized.\nTask: ${args.task_summary}\n\nNow use add_agent to create specialized agents for this task. Each agent will be created as a real .md file in .aboocode/agents/ and loaded via hot-reload.`,
      metadata: {},
    }
  },
})

// ─── add_agent ───
export const AddAgentTool = Tool.define<
  z.ZodObject<{
    agent_id: z.ZodString
    name: z.ZodString
    description: z.ZodString
    system_prompt: z.ZodString
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>
  }>,
  {}
>("add_agent", {
  description:
    "Add a specialized agent to the team. This writes an agent .md file to .aboocode/agents/ which is automatically loaded via hot-reload. Each agent should have a focused responsibility.",
  parameters: z.object({
    agent_id: z
      .string()
      .describe("Unique identifier for the agent (e.g., 'auth-model-dev'). Used as the filename."),
    name: z.string().describe("Human-readable name for the agent"),
    description: z.string().describe("What this agent specializes in"),
    system_prompt: z.string().describe("Detailed system prompt for the agent explaining its task and approach"),
    skills: z.array(z.string()).optional().describe("Skill names to assign to this agent"),
  }),
  async execute(args, ctx) {
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
    const content = [
      "---",
      `name: ${args.name}`,
      `description: ${args.description}`,
      "mode: subagent",
      "permission:",
      "  read: allow",
      "  write: allow",
      "  edit: allow",
      "  bash: allow",
      "  glob: allow",
      "  grep: allow",
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
  }>,
  {}
>("delegate_task", {
  description:
    "Delegate a task to a specific team agent. The agent will execute the task in a child session. Use this for sequential task delegation where order matters.",
  parameters: z.object({
    agent_id: z.string().describe("The ID of the agent to delegate to"),
    task: z.string().describe("Detailed description of the task for the agent"),
  }),
  async execute(args, ctx) {
    const agent = await Agent.get(args.agent_id)
    if (!agent) {
      return {
        title: "Error",
        output: `Agent "${args.agent_id}" not found. Make sure the agent was created with add_agent.`,
        metadata: {},
      }
    }

    log.info("delegating task", { agent: args.agent_id, task: args.task })

    // Create child session
    const childSession = await Session.create({
      parentID: ctx.sessionID,
      title: `Team task: ${args.agent_id}`,
    })

    // Propagate parent abort to child
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
        .filter((p): p is { type: "text"; text: string } & Record<string, any> => p.type === "text")
        .map((p) => p.text)
        .join("\n")

      return {
        title: `Task Complete: ${args.agent_id}`,
        output: `Agent "${args.agent_id}" completed the task.\n\nSession: ${childSession.id}\n\n## Result\n${output || "(No text output)"}`,
        metadata: { sessionID: childSession.id },
      }
    } catch (error: any) {
      return {
        title: `Task Failed: ${args.agent_id}`,
        output: `Agent "${args.agent_id}" failed: ${error.message}`,
        metadata: { sessionID: childSession.id, error: error.message },
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
    const maxConcurrent = 5
    const results: Record<string, { status: "success" | "error"; output: string; sessionID?: string }> = {}

    // Build dependency graph
    const taskMap = new Map(args.delegations.map((d) => [d.agent_id, d]))
    const completed = new Set<string>()
    const failed = new Set<string>()

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
          .filter((p): p is { type: "text"; text: string } & Record<string, any> => p.type === "text")
          .map((p) => p.text)
          .join("\n")

        results[delegation.agent_id] = {
          status: "success",
          output: output || "(No text output)",
          sessionID: childSession.id,
        }
        completed.add(delegation.agent_id)
      } catch (error: any) {
        results[delegation.agent_id] = {
          status: "error",
          output: error.message,
          sessionID: childSession.id,
        }
        failed.add(delegation.agent_id)
      } finally {
        ctx.abort.removeEventListener("abort", onAbort)
      }
    }

    // Execute in waves based on dependencies
    const remaining = new Set(args.delegations.map((d) => d.agent_id))

    while (remaining.size > 0) {
      // Find tasks whose dependencies are all satisfied
      const ready: typeof args.delegations = []
      for (const delegation of args.delegations) {
        if (!remaining.has(delegation.agent_id)) continue
        const deps = delegation.depends_on ?? []
        const allDepsResolved = deps.every((d) => completed.has(d) || failed.has(d))
        if (allDepsResolved) {
          ready.push(delegation)
        }
      }

      if (ready.length === 0) {
        // Deadlock or all remaining tasks have unresolvable dependencies
        for (const id of remaining) {
          results[id] = {
            status: "error",
            output: "Task could not execute: unresolvable dependency cycle or failed dependency.",
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

    // Format output
    const lines: string[] = [`## Parallel Execution Results (${Object.keys(results).length} tasks)`]
    for (const [agentId, result] of Object.entries(results)) {
      const icon = result.status === "success" ? "[OK]" : "[FAILED]"
      lines.push(`\n### ${icon} ${agentId}`)
      lines.push(result.output)
      if (result.sessionID) lines.push(`Session: ${result.sessionID}`)
    }

    return {
      title: `Parallel Tasks Complete`,
      output: lines.join("\n"),
      metadata: { results },
    }
  },
})

// ─── list_team ───
export const ListTeamTool = Tool.define<z.ZodObject<{}>, {}>("list_team", {
  description: "List all agents in the current team and their status.",
  parameters: z.object({}),
  async execute(_args, ctx) {
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

    // Clean up team state
    TeamManager.disbandTeam(ctx.sessionID)

    return {
      title: "Team Disbanded",
      output: `Team disbanded. ${deleted.length} agent files deleted:\n${deleted.map((f) => `- ${f}`).join("\n")}\n\nAll team agents have been removed from the system.`,
      metadata: { deleted },
    }
  },
})
