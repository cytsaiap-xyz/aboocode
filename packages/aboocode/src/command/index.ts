import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_MEMORY from "./template/memory.txt"
import PROMPT_COMPACT from "./template/compact.txt"
import PROMPT_CLEAR from "./template/clear.txt"
import PROMPT_PLAN from "./template/plan.txt"
import PROMPT_HOOKS from "./template/hooks.txt"
import PROMPT_AGENTS from "./template/agents.txt"
import PROMPT_OUTPUT_STYLE from "./template/output-style.txt"
import PROMPT_MCP from "./template/mcp.txt"
import PROMPT_MODEL from "./template/model.txt"
import PROMPT_RESUME from "./template/resume.txt"
import PROMPT_HELP from "./template/help.txt"
// Phase 14: 20 new bundled slash commands
import PROMPT_COST from "./template/cost.txt"
import PROMPT_STATUS from "./template/status.txt"
import PROMPT_DOCTOR from "./template/doctor.txt"
import PROMPT_TASKS from "./template/tasks.txt"
import PROMPT_LOGIN from "./template/login.txt"
import PROMPT_LOGOUT from "./template/logout.txt"
import PROMPT_PERMISSIONS from "./template/permissions.txt"
import PROMPT_CONTEXT from "./template/context.txt"
import PROMPT_BRANCH from "./template/branch.txt"
import PROMPT_DIFF from "./template/diff.txt"
import PROMPT_FAST from "./template/fast.txt"
import PROMPT_CONFIG from "./template/config.txt"
import PROMPT_SESSION from "./template/session.txt"
import PROMPT_SKILLS from "./template/skills.txt"
import PROMPT_TODOS from "./template/todos.txt"
import PROMPT_NOTES from "./template/notes.txt"
import PROMPT_PRD from "./template/prd.txt"
import PROMPT_EXPLAIN from "./template/explain.txt"
import PROMPT_ONBOARD from "./template/onboard.txt"
import PROMPT_UNDO from "./template/undo.txt"
import { MCP } from "../mcp"
import { Skill } from "../skill"

export namespace Command {
  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      source: z.enum(["command", "mcp", "skill"]).optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      subtask: z.boolean().optional(),
      hints: z.array(z.string()),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  export const Default = {
    INIT: "init",
    REVIEW: "review",
    MEMORY: "memory",
    COMPACT: "compact",
    CLEAR: "clear",
    PLAN: "plan",
    HOOKS: "hooks",
    AGENTS: "agents",
    OUTPUT_STYLE: "output-style",
    MCP: "mcp",
    MODEL: "model",
    RESUME: "resume",
    HELP: "help",
    // Phase 14: 20 new bundled slash commands
    COST: "cost",
    STATUS: "status",
    DOCTOR: "doctor",
    TASKS: "tasks",
    LOGIN: "login",
    LOGOUT: "logout",
    PERMISSIONS: "permissions",
    CONTEXT: "context",
    BRANCH: "branch",
    DIFF: "diff",
    FAST: "fast",
    CONFIG: "config",
    SESSION: "session",
    SKILLS: "skills",
    TODOS: "todos",
    NOTES: "notes",
    PRD: "prd",
    EXPLAIN: "explain",
    ONBOARD: "onboard",
    UNDO: "undo",
  } as const

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      },
      [Default.MEMORY]: {
        name: Default.MEMORY,
        description: "show memory system status and loaded instructions",
        source: "command",
        get template() {
          return PROMPT_MEMORY
        },
        hints: hints(PROMPT_MEMORY),
      },
      [Default.COMPACT]: {
        name: Default.COMPACT,
        description: "compact the current conversation to free up context",
        source: "command",
        get template() {
          return PROMPT_COMPACT
        },
        hints: hints(PROMPT_COMPACT),
      },
      [Default.CLEAR]: {
        name: Default.CLEAR,
        description: "clear the conversation context",
        source: "command",
        get template() {
          return PROMPT_CLEAR
        },
        hints: hints(PROMPT_CLEAR),
      },
      [Default.PLAN]: {
        name: Default.PLAN,
        description: "enter read-only plan mode to investigate and design a change",
        source: "command",
        get template() {
          return PROMPT_PLAN
        },
        hints: hints(PROMPT_PLAN),
      },
      [Default.HOOKS]: {
        name: Default.HOOKS,
        description: "show configured lifecycle hooks and how to add new ones",
        source: "command",
        get template() {
          return PROMPT_HOOKS
        },
        hints: hints(PROMPT_HOOKS),
      },
      [Default.AGENTS]: {
        name: Default.AGENTS,
        description: "list available agents and how to switch",
        source: "command",
        get template() {
          return PROMPT_AGENTS
        },
        hints: hints(PROMPT_AGENTS),
      },
      [Default.OUTPUT_STYLE]: {
        name: Default.OUTPUT_STYLE,
        description: "switch the session's output style (default/concise/explanatory)",
        source: "command",
        get template() {
          return PROMPT_OUTPUT_STYLE
        },
        hints: hints(PROMPT_OUTPUT_STYLE),
      },
      [Default.MCP]: {
        name: Default.MCP,
        description: "show connected MCP servers and their tools/resources/prompts",
        source: "command",
        get template() {
          return PROMPT_MCP
        },
        hints: hints(PROMPT_MCP),
      },
      [Default.MODEL]: {
        name: Default.MODEL,
        description: "switch the model used for this session",
        source: "command",
        get template() {
          return PROMPT_MODEL
        },
        hints: hints(PROMPT_MODEL),
      },
      [Default.RESUME]: {
        name: Default.RESUME,
        description: "resume a prior session",
        source: "command",
        get template() {
          return PROMPT_RESUME
        },
        hints: hints(PROMPT_RESUME),
      },
      [Default.HELP]: {
        name: Default.HELP,
        description: "list available slash commands",
        source: "command",
        get template() {
          return PROMPT_HELP
        },
        hints: hints(PROMPT_HELP),
      },
      // Phase 14 additions. Each is a template-backed command that the
      // model expands on execution; no new tools are required beyond what
      // Phases 11–13 already provide.
      [Default.COST]: { name: Default.COST, description: "show cost + token usage", source: "command", get template() { return PROMPT_COST }, hints: hints(PROMPT_COST) },
      [Default.STATUS]: { name: Default.STATUS, description: "show concise session status", source: "command", get template() { return PROMPT_STATUS }, hints: hints(PROMPT_STATUS) },
      [Default.DOCTOR]: { name: Default.DOCTOR, description: "run environment diagnostics", source: "command", get template() { return PROMPT_DOCTOR }, hints: hints(PROMPT_DOCTOR) },
      [Default.TASKS]: { name: Default.TASKS, description: "list tracked tasks", source: "command", get template() { return PROMPT_TASKS }, hints: hints(PROMPT_TASKS) },
      [Default.LOGIN]: { name: Default.LOGIN, description: "sign in to a provider", source: "command", get template() { return PROMPT_LOGIN }, hints: hints(PROMPT_LOGIN) },
      [Default.LOGOUT]: { name: Default.LOGOUT, description: "revoke provider credentials", source: "command", get template() { return PROMPT_LOGOUT }, hints: hints(PROMPT_LOGOUT) },
      [Default.PERMISSIONS]: { name: Default.PERMISSIONS, description: "show permission mode + ruleset", source: "command", get template() { return PROMPT_PERMISSIONS }, hints: hints(PROMPT_PERMISSIONS) },
      [Default.CONTEXT]: { name: Default.CONTEXT, description: "break down context-window usage", source: "command", get template() { return PROMPT_CONTEXT }, hints: hints(PROMPT_CONTEXT) },
      [Default.BRANCH]: { name: Default.BRANCH, description: "show current git branch state", source: "command", get template() { return PROMPT_BRANCH }, hints: hints(PROMPT_BRANCH) },
      [Default.DIFF]: { name: Default.DIFF, description: "show working-tree or ref diff", source: "command", get template() { return PROMPT_DIFF }, hints: hints(PROMPT_DIFF) },
      [Default.FAST]: { name: Default.FAST, description: "switch to fast mode (smaller model)", source: "command", get template() { return PROMPT_FAST }, hints: hints(PROMPT_FAST) },
      [Default.CONFIG]: { name: Default.CONFIG, description: "show merged aboocode configuration", source: "command", get template() { return PROMPT_CONFIG }, hints: hints(PROMPT_CONFIG) },
      [Default.SESSION]: { name: Default.SESSION, description: "show session info", source: "command", get template() { return PROMPT_SESSION }, hints: hints(PROMPT_SESSION) },
      [Default.SKILLS]: { name: Default.SKILLS, description: "list available skills", source: "command", get template() { return PROMPT_SKILLS }, hints: hints(PROMPT_SKILLS) },
      [Default.TODOS]: { name: Default.TODOS, description: "show / update todo list", source: "command", get template() { return PROMPT_TODOS }, hints: hints(PROMPT_TODOS) },
      [Default.NOTES]: { name: Default.NOTES, description: "review recent session notes", source: "command", get template() { return PROMPT_NOTES }, hints: hints(PROMPT_NOTES) },
      [Default.PRD]: { name: Default.PRD, description: "draft a one-page PRD", source: "command", get template() { return PROMPT_PRD }, hints: hints(PROMPT_PRD) },
      [Default.EXPLAIN]: { name: Default.EXPLAIN, description: "explain a file, function, or concept", source: "command", get template() { return PROMPT_EXPLAIN }, hints: hints(PROMPT_EXPLAIN) },
      [Default.ONBOARD]: { name: Default.ONBOARD, description: "produce an onboarding guide", source: "command", get template() { return PROMPT_ONBOARD }, hints: hints(PROMPT_ONBOARD) },
      [Default.UNDO]: { name: Default.UNDO, description: "undo the agent's last change", source: "command", get template() { return PROMPT_UNDO }, hints: hints(PROMPT_UNDO) },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        source: "command",
        get template() {
          return command.template
        },
        subtask: command.subtask,
        hints: hints(command.template),
      }
    }
    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      result[name] = {
        name,
        source: "mcp",
        description: prompt.description,
        get template() {
          // since a getter can't be async we need to manually return a promise here
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? // substitute each argument with $1, $2, etc.
                  Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).catch(reject)
            resolve(
              template?.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          })
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      }
    }

    // Add skills as invokable commands
    for (const skill of await Skill.all()) {
      // Skip if a command with this name already exists
      if (result[skill.name]) continue
      result[skill.name] = {
        name: skill.name,
        description: skill.description,
        source: "skill",
        get template() {
          return skill.content
        },
        hints: [],
      }
    }

    return result
  })

  export async function reload() {
    const s = await state()
    for (const key of Object.keys(s)) {
      delete s[key]
    }

    const cfg = await Config.get()

    s[Default.INIT] = {
      name: Default.INIT,
      description: "create/update AGENTS.md",
      source: "command",
      get template() {
        return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
      },
      hints: hints(PROMPT_INITIALIZE),
    }
    s[Default.REVIEW] = {
      name: Default.REVIEW,
      description: "review changes [commit|branch|pr], defaults to uncommitted",
      source: "command",
      get template() {
        return PROMPT_REVIEW.replace("${path}", Instance.worktree)
      },
      subtask: true,
      hints: hints(PROMPT_REVIEW),
    }
    s[Default.MEMORY] = {
      name: Default.MEMORY,
      description: "show memory system status and loaded instructions",
      source: "command",
      get template() {
        return PROMPT_MEMORY
      },
      hints: hints(PROMPT_MEMORY),
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      s[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        source: "command",
        get template() {
          return command.template
        },
        subtask: command.subtask,
        hints: hints(command.template),
      }
    }
    for (const [name, prompt] of Object.entries(await MCP.prompts())) {
      s[name] = {
        name,
        source: "mcp",
        description: prompt.description,
        get template() {
          return new Promise<string>(async (resolve, reject) => {
            const template = await MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? Object.fromEntries(prompt.arguments?.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).catch(reject)
            resolve(
              template?.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          })
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      }
    }

    for (const skill of await Skill.all()) {
      if (s[skill.name]) continue
      s[skill.name] = {
        name: skill.name,
        description: skill.description,
        source: "skill",
        get template() {
          return skill.content
        },
        hints: [],
      }
    }
  }

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }
}
