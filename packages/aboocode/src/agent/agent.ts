import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_ORCHESTRATOR from "./prompt/orchestrator.txt"
import PROMPT_OBSERVER from "./prompt/observer.txt"
import PROMPT_VERIFICATION from "./prompt/verification.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { ConfigMarkdown } from "../config/markdown"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import { KnowledgeBridge } from "../team/knowledge-bridge"

export namespace Agent {
  const log = Log.create({ service: "agent" })

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
      allowedTools: z.string().array().optional().describe("If set, only these tools are available to this agent"),
      disallowedTools: z.string().array().optional().describe("If set, these tools are excluded for this agent"),
      isolation: z
        .enum(["shared", "read_only", "temp", "worktree"])
        .optional()
        .describe("Workspace isolation mode for this agent"),
      backgroundCapable: z.boolean().optional().describe("Whether this agent can run as a background task"),
      maxTurns: z.number().int().positive().optional().describe("Maximum conversation turns for this agent"),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  async function buildOrchestratorPrompt(): Promise<string> {
    let prompt = PROMPT_ORCHESTRATOR

    // Inject coordinator mode config
    const cfg = await Config.get()
    const coordinator = cfg.coordinator
    if (coordinator?.proactive) {
      const maxRounds = coordinator.maxRounds ?? 10
      prompt = prompt.replace(
        "coordinator.proactive: true",
        `coordinator.proactive: true (ENABLED — max ${maxRounds} rounds)`,
      )
    } else {
      // Replace the coordinator section hint to make disabled state explicit
      prompt = prompt.replace(
        "When coordinator mode is disabled (default), operate reactively — only respond to explicit user requests.",
        "Coordinator mode is DISABLED. Operate reactively — only respond to explicit user requests. Do NOT take proactive actions.",
      )
    }

    // Inject available skills
    const skills = await Skill.all()
    const skillsSection = skills.length > 0
      ? skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n")
      : "No skills currently available."
    prompt = prompt.replace("{skills}", skillsSection)

    // Inject knowledge context
    const knowledge = await KnowledgeBridge.loadKnowledgeContext()
    const knowledgeSection = KnowledgeBridge.buildOrchestratorKnowledgeSection(knowledge)
    prompt = prompt.replace("{knowledge}", knowledgeSection)

    return prompt
  }

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const skillDirs = await Skill.dirs()
    const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]
    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      build: {
        name: "build",
        description: "The default agent. Executes tools based on configured permissions.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      plan: {
        name: "plan",
        description: "Plan mode. Disallows all edit tools.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".aboocode", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      explore: {
        name: "explore",
        isolation: "read_only",
        backgroundCapable: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            // bash is blocked by isToolBlocked() for read_only agents (Phase 3)
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            read: "allow",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
      "memory-extractor": {
        name: "memory-extractor",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.3,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: `You are a memory management agent. Review the conversation and produce markdown notes to append to the project's MEMORY.md file.

Output markdown to APPEND to MEMORY.md. Keep entries concise (1-2 lines each).

Focus ONLY on durable, non-derivable facts:
- User preferences, role, and feedback about how to work
- Project goals, constraints, deadlines, and external drivers
- Decisions with non-obvious rationale (the "why" behind a choice)
- Lessons learned from debugging (root cause insights, not the fix itself)
- References to external systems (issue trackers, dashboards, docs)

Do NOT save any of the following — they can be derived from code or git history:
- Architecture summaries, design overviews, or code patterns
- Coding conventions, style rules, or file structure descriptions
- File paths, function signatures, or implementation details
- Technology stack or dependency information
- Session recaps or activity logs

Format: plain markdown with headers and bullets.

If nothing worth remembering, respond with an empty string.`,
      },
      "session-observer": {
        name: "session-observer",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.3,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_OBSERVER,
      },
      orchestrator: {
        name: "orchestrator",
        description: "Multi-agent orchestrator. Plans and delegates complex tasks across a team of specialized agents.",
        mode: "primary",
        native: true,
        prompt: await buildOrchestratorPrompt(),
        // Enforce maxTurns from coordinator config as a runtime safety net
        steps: cfg.coordinator?.proactive ? (cfg.coordinator.maxRounds ?? 10) * 3 : undefined,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            plan_team: "allow",
            add_agent: "allow",
            finalize_team: "allow",
            delegate_task: "allow",
            delegate_tasks: "allow",
            discuss: "allow",
            list_team: "allow",
            disband_team: "allow",
            question: "allow",
            skill: "allow",
          }),
          user,
        ),
        options: {},
      },
      verification: {
        name: "verification",
        description:
          "Independent verification agent. Runs actual commands to check work correctness. Reports PASS/FAIL/PARTIAL with evidence. Cannot modify project files.",
        mode: "subagent",
        native: true,
        temperature: 0.3,
        isolation: "read_only",
        backgroundCapable: true,
        prompt: PROMPT_VERIFICATION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            // bash is blocked by isToolBlocked() for read_only agents (Phase 3)
            webfetch: "allow",
            write: "deny",
            edit: "deny",
            apply_patch: "deny",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
          }),
          user,
        ),
        options: {},
      },
    }

    // Scan .aboocode/agents/ directories for custom agent .md files
    for (const dir of await Config.directories()) {
      const matches = await Glob.scan("{agent,agents}/*.md", {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        const md = await ConfigMarkdown.parse(match).catch((err) => {
          log.error("failed to load agent", { agent: match, err })
          return undefined
        })
        if (!md) continue

        const agentId = path.basename(match, ".md")
        const data = md.data as Record<string, any>

        // Build permission from frontmatter
        const permConfig: Record<string, any> = {}
        if (data.permission && typeof data.permission === "object") {
          for (const [k, v] of Object.entries(data.permission)) {
            permConfig[k] = v
          }
        }

        result[agentId] = {
          name: data.name ?? agentId,
          description: data.description ?? "",
          mode: data.mode ?? "subagent",
          native: false,
          hidden: data.hidden ?? false,
          prompt: md.content,
          permission: PermissionNext.merge(
            defaults,
            PermissionNext.fromConfig(permConfig),
            user,
          ),
          options: data.options ?? {},
          ...(data.model ? { model: Provider.parseModel(data.model) } : {}),
          ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
          ...(data.steps !== undefined ? { steps: data.steps } : {}),
          ...(data.isolation ? { isolation: data.isolation } : {}),
          ...(data.backgroundCapable !== undefined ? { backgroundCapable: data.backgroundCapable } : {}),
          ...(data.allowedTools ? { allowedTools: data.allowedTools } : {}),
          ...(data.disallowedTools ? { disallowedTools: data.disallowedTools } : {}),
          ...(data.maxTurns !== undefined ? { maxTurns: data.maxTurns } : {}),
        }
      }
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
    }

    // Ensure Truncate.GLOB is allowed unless explicitly configured
    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  })

  export async function reload() {
    log.info("reloading agents from config directories")
    const s = await state()

    // Remove non-native agents (these are from .md files, will be re-scanned)
    for (const key of Object.keys(s)) {
      if (!s[key].native) {
        delete s[key]
      }
    }

    // Re-scan .aboocode/agents/ directories for custom agent .md files
    const cfg = await Config.get()
    const user = PermissionNext.fromConfig(cfg.permission ?? {})
    const skillDirs = await Skill.dirs()
    const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]
    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })

    for (const dir of await Config.directories()) {
      const matches = await Glob.scan("{agent,agents}/*.md", {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        const md = await ConfigMarkdown.parse(match).catch((err) => {
          log.error("failed to load agent", { agent: match, err })
          return undefined
        })
        if (!md) continue

        const agentId = path.basename(match, ".md")
        const data = md.data as Record<string, any>

        const permConfig: Record<string, any> = {}
        if (data.permission && typeof data.permission === "object") {
          for (const [k, v] of Object.entries(data.permission)) {
            permConfig[k] = v
          }
        }

        s[agentId] = {
          name: data.name ?? agentId,
          description: data.description ?? "",
          mode: data.mode ?? "subagent",
          native: false,
          hidden: data.hidden ?? false,
          prompt: md.content,
          permission: PermissionNext.merge(
            defaults,
            PermissionNext.fromConfig(permConfig),
            user,
          ),
          options: data.options ?? {},
          ...(data.model ? { model: Provider.parseModel(data.model) } : {}),
          ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
          ...(data.steps !== undefined ? { steps: data.steps } : {}),
          ...(data.isolation ? { isolation: data.isolation } : {}),
          ...(data.backgroundCapable !== undefined ? { backgroundCapable: data.backgroundCapable } : {}),
          ...(data.allowedTools ? { allowedTools: data.allowedTools } : {}),
          ...(data.disallowedTools ? { disallowedTools: data.disallowedTools } : {}),
          ...(data.maxTurns !== undefined ? { maxTurns: data.maxTurns } : {}),
        }
      }
    }
    log.info("reloaded agents", { count: Object.keys(s).length })
  }

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"]),
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const primaryVisible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
