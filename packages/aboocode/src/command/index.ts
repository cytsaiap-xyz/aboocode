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
