import z from "zod"
import path from "path"
import os from "os"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@aboocode/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { Discovery } from "./discovery"
import { Glob } from "../util/glob"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  // External skill directories to search for (project-level and global)
  // These follow the directory layout used by Claude Code and other agents.
  const EXTERNAL_DIRS = [".claude", ".agents"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const ABOOCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"

  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}
    const dirs = new Set<string>()

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      // Warn on duplicate skill names
      if (skills[parsed.data.name]) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: skills[parsed.data.name].location,
          duplicate: match,
        })
      }

      dirs.add(path.dirname(match))

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
      }
    }

    const scanExternal = async (root: string, scope: "global" | "project") => {
      return Glob.scan(EXTERNAL_SKILL_PATTERN, {
        cwd: root,
        absolute: true,
        include: "file",
        dot: true,
        symlink: true,
      })
        .then((matches) => Promise.all(matches.map(addSkill)))
        .catch((error) => {
          log.error(`failed to scan ${scope} skills`, { dir: root, error })
        })
    }

    // Scan external skill directories (.claude/skills/, .agents/skills/, etc.)
    // Load global (home) first, then project-level (so project-level overwrites)
    if (!Flag.ABOOCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (!(await Filesystem.isDir(root))) continue
        await scanExternal(root, "global")
      }

      for await (const root of Filesystem.up({
        targets: EXTERNAL_DIRS,
        start: Instance.directory,
        stop: Instance.worktree,
      })) {
        await scanExternal(root, "project")
      }
    }

    // Scan .aboocode/skill/ directories
    for (const dir of await Config.directories()) {
      const matches = await Glob.scan(ABOOCODE_SKILL_PATTERN, {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    // Scan additional skill paths from config
    const config = await Config.get()
    for (const skillPath of config.skills?.paths ?? []) {
      const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath
      const resolved = path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded)
      if (!(await Filesystem.isDir(resolved))) {
        log.warn("skill path not found", { path: resolved })
        continue
      }
      const matches = await Glob.scan(SKILL_PATTERN, {
        cwd: resolved,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    // Download and load skills from URLs
    for (const url of config.skills?.urls ?? []) {
      const list = await Discovery.pull(url)
      for (const dir of list) {
        dirs.add(dir)
        const matches = await Glob.scan(SKILL_PATTERN, {
          cwd: dir,
          absolute: true,
          include: "file",
          symlink: true,
        })
        for (const match of matches) {
          await addSkill(match)
        }
      }
    }

    // Phase 8 integration: merge bundled skills so users get useful defaults
    // out of the box. Disk-based skills take precedence over bundled ones
    // when they share a name.
    try {
      const { BUNDLED_SKILLS } = await import("./bundled")
      for (const bundled of BUNDLED_SKILLS) {
        if (skills[bundled.name]) continue
        skills[bundled.name] = {
          name: bundled.name,
          description: bundled.description,
          location: `bundled://${bundled.name}`,
          content: bundled.content,
        }
      }
    } catch (err) {
      log.warn("failed to load bundled skills", { err })
    }

    // Phase 8 integration: merge MCP-backed skills (wraps MCP prompts).
    // Lazy — only called during Skill.state() init; the MCP prompt bodies
    // are fetched on demand by materializeMcpSkill().
    try {
      const { buildMcpSkills } = await import("./mcp-builders")
      const mcpSkills = await buildMcpSkills()
      for (const mcp of mcpSkills) {
        if (skills[mcp.name]) continue
        skills[mcp.name] = {
          name: mcp.name,
          description: mcp.description,
          location: mcp.location,
          content: mcp.content,
        }
      }
    } catch (err) {
      log.warn("failed to load mcp skills", { err })
    }

    return {
      skills,
      dirs: Array.from(dirs),
    }
  })

  export async function reload() {
    log.info("reloading skills")
    const s = await state()
    // Clear and re-scan
    for (const key of Object.keys(s.skills)) {
      delete s.skills[key]
    }
    s.dirs.length = 0

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })
      if (!md) return
      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return
      s.dirs.push(path.dirname(match))
      s.skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
      }
    }

    // Re-scan all skill sources
    if (!Flag.ABOOCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (!(await Filesystem.isDir(root))) continue
        const matches = await Glob.scan(EXTERNAL_SKILL_PATTERN, {
          cwd: root, absolute: true, include: "file", dot: true, symlink: true,
        })
        await Promise.all(matches.map(addSkill))
      }
      for await (const root of Filesystem.up({
        targets: EXTERNAL_DIRS,
        start: Instance.directory,
        stop: Instance.worktree,
      })) {
        const matches = await Glob.scan(EXTERNAL_SKILL_PATTERN, {
          cwd: root, absolute: true, include: "file", dot: true, symlink: true,
        })
        await Promise.all(matches.map(addSkill))
      }
    }

    for (const dir of await Config.directories()) {
      const matches = await Glob.scan(ABOOCODE_SKILL_PATTERN, {
        cwd: dir, absolute: true, include: "file", symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    log.info("reloaded skills", { count: Object.keys(s.skills).length })
  }

  export async function get(name: string) {
    return state().then((x) => x.skills[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x.skills))
  }

  export async function dirs() {
    return state().then((x) => x.dirs)
  }
}
