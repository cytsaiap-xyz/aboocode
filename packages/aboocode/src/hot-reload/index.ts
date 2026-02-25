import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { FileWatcher } from "../file/watcher"
import { Config } from "../config/config"
import path from "path"

export namespace HotReload {
  const log = Log.create({ service: "hot-reload" })

  export const Event = {
    Reloaded: BusEvent.define(
      "hot-reload.reloaded",
      z.object({
        type: z.enum(["tool", "skill", "agent"]),
        files: z.array(z.string()),
      }),
    ),
  }

  // Patterns to classify file changes
  function isToolFile(file: string): boolean {
    const rel = relative(file)
    if (!rel) return false
    return /^(tool|tools)\//.test(rel) && /\.(ts|js)$/.test(rel)
  }

  function isSkillFile(file: string): boolean {
    const rel = relative(file)
    if (!rel) return false
    return /^(skill|skills)\//.test(rel) && /SKILL\.md$/i.test(rel)
  }

  function isAgentFile(file: string): boolean {
    const rel = relative(file)
    if (!rel) return false
    return /^(agent|agents)\//.test(rel) && /\.md$/.test(rel)
  }

  let configDirs: string[] = []

  function relative(file: string): string | undefined {
    for (const dir of configDirs) {
      if (file.startsWith(dir + "/") || file.startsWith(dir + path.sep)) {
        return file.slice(dir.length + 1)
      }
    }
    return undefined
  }

  // Debounce state
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; type: "tool" | "skill" | "agent" }>()

  // Agents directory gets immediate reload (no debounce) for team workflow
  function isAgentsDir(file: string): boolean {
    for (const dir of configDirs) {
      const agentsDir = path.join(dir, "agents")
      if (file.startsWith(agentsDir + "/") || file.startsWith(agentsDir + path.sep)) {
        return true
      }
    }
    return false
  }

  async function handleChange(file: string, event: "add" | "change" | "unlink") {
    let type: "tool" | "skill" | "agent" | undefined
    if (isToolFile(file)) type = "tool"
    else if (isSkillFile(file)) type = "skill"
    else if (isAgentFile(file)) type = "agent"

    if (!type) return

    log.info("detected change", { type, file, event })

    // For agent files in .aboocode/agents/, reload immediately (team workflow needs this)
    if (type === "agent" && isAgentsDir(file)) {
      await doReload(type, [file])
      return
    }

    // Debounce other changes by 500ms
    const existing = pending.get(file)
    if (existing) {
      clearTimeout(existing.timer)
    }

    pending.set(file, {
      type,
      timer: setTimeout(async () => {
        pending.delete(file)
        await doReload(type!, [file])
      }, 500),
    })
  }

  async function doReload(type: "tool" | "skill" | "agent", files: string[]) {
    log.info("reloading", { type, files })
    try {
      // Dynamic imports to avoid circular dependencies
      if (type === "tool") {
        const { ToolRegistry } = await import("../tool/registry")
        await ToolRegistry.reload()
      } else if (type === "skill") {
        const { Skill } = await import("../skill/skill")
        await Skill.reload()
      } else if (type === "agent") {
        const { Agent } = await import("../agent/agent")
        await Agent.reload()
      }

      Bus.publish(Event.Reloaded, { type, files })
      log.info("reload complete", { type, files })
    } catch (error) {
      log.error("reload failed", { type, files, error })
    }
  }

  export function init() {
    Config.directories().then((dirs) => {
      configDirs = dirs
      log.info("watching config directories", { dirs })
    })

    Bus.subscribe(FileWatcher.Event.Updated, (evt) => {
      handleChange(evt.properties.file, evt.properties.event)
    })

    log.info("initialized")
  }
}
