import path from "path"
import os from "os"
import { minimatch } from "minimatch"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { Log } from "../util/log"
import { Glob } from "../util/glob"
import { ConfigMarkdown } from "../config/markdown"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "instruction" })

const FILES = [
  "AGENTS.md",
  "ABOO.md",
  "CLAUDE.md",
  "CONTEXT.md", // deprecated
]

const LOCAL_FILES = [
  "AGENTS.local.md",
  "ABOO.local.md",
  "CLAUDE.local.md",
]

function globalFiles() {
  const files = []
  if (Flag.ABOOCODE_CONFIG_DIR) {
    files.push(path.join(Flag.ABOOCODE_CONFIG_DIR, "AGENTS.md"))
  }
  files.push(path.join(Global.Path.config, "AGENTS.md"))
  if (!Flag.ABOOCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(os.homedir(), ".aboocode", "ABOO.md"))
    files.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }
  return files
}

async function resolveRelative(instruction: string): Promise<string[]> {
  if (!Flag.ABOOCODE_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.ABOOCODE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no ABOOCODE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.ABOOCODE_CONFIG_DIR, Flag.ABOOCODE_CONFIG_DIR).catch(() => [])
}

export namespace InstructionPrompt {
  const state = Instance.state(() => {
    return {
      claims: new Map<string, Set<string>>(),
    }
  })

  function isClaimed(messageID: string, filepath: string) {
    const claimed = state().claims.get(messageID)
    if (!claimed) return false
    return claimed.has(filepath)
  }

  function claim(messageID: string, filepath: string) {
    const current = state()
    let claimed = current.claims.get(messageID)
    if (!claimed) {
      claimed = new Set()
      current.claims.set(messageID, claimed)
    }
    claimed.add(filepath)
  }

  export function clear(messageID: string) {
    state().claims.delete(messageID)
  }

  function isExcluded(filepath: string, excludes: string[]): boolean {
    return excludes.some((pattern) => minimatch(filepath, pattern, { matchBase: true }))
  }

  const MAX_IMPORT_DEPTH = 5

  async function expandImports(
    content: string,
    sourceFilePath: string,
    depth = 0,
    visited = new Set<string>(),
  ): Promise<string> {
    if (depth >= MAX_IMPORT_DEPTH) return content
    visited.add(sourceFilePath)

    const sourceDir = path.dirname(sourceFilePath)
    const regex = new RegExp(ConfigMarkdown.FILE_REGEX.source, ConfigMarkdown.FILE_REGEX.flags)
    const matches = Array.from(content.matchAll(regex))

    if (matches.length === 0) return content

    let result = content
    for (const match of matches) {
      const ref = match[1]
      if (!ref) continue
      const refPath = path.resolve(sourceDir, ref)

      if (visited.has(refPath)) {
        log.warn("circular @import detected", { from: sourceFilePath, ref: refPath })
        continue
      }

      const refContent = await Filesystem.readText(refPath).catch(() => {
        log.warn("@import file not found, leaving as literal", { from: sourceFilePath, ref: refPath })
        return null
      })

      if (refContent !== null) {
        const expanded = await expandImports(refContent, refPath, depth + 1, new Set(visited))
        result = result.replace(match[0], expanded)
      }
    }

    return result
  }

  function managedPaths(): string[] {
    const results: string[] = []
    if (process.platform === "darwin") {
      results.push("/Library/Application Support/aboocode/ABOO.md")
    } else if (process.platform === "linux") {
      results.push("/etc/aboocode/ABOO.md")
    }
    return results
  }

  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()
    const managed = new Set<string>()

    // Load managed policy paths (cannot be excluded)
    for (const mp of managedPaths()) {
      if (await Filesystem.exists(mp)) {
        const resolved = path.resolve(mp)
        paths.add(resolved)
        managed.add(resolved)
      }
    }

    if (!Flag.ABOOCODE_DISABLE_PROJECT_CONFIG) {
      for (const file of FILES) {
        const matches = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.forEach((p) => {
            paths.add(path.resolve(p))
          })
          // Also search for local variants in the same directories
          const dirs = new Set(matches.map((p) => path.dirname(path.resolve(p))))
          for (const dir of dirs) {
            for (const localFile of LOCAL_FILES) {
              const localPath = path.join(dir, localFile)
              if (await Filesystem.exists(localPath)) {
                paths.add(path.resolve(localPath))
              }
            }
          }
          break
        }
      }
    }

    for (const file of globalFiles()) {
      if (await Filesystem.exists(file)) {
        paths.add(path.resolve(file))
        break
      }
    }

    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        const matches = path.isAbsolute(instruction)
          ? await Glob.scan(path.basename(instruction), {
              cwd: path.dirname(instruction),
              absolute: true,
              include: "file",
            }).catch(() => [])
          : await resolveRelative(instruction)
        matches.forEach((p) => {
          paths.add(path.resolve(p))
        })
      }
    }

    // Filter excluded paths (managed paths cannot be excluded)
    const excludes = config.abooMdExcludes ?? []
    if (excludes.length > 0) {
      for (const p of paths) {
        if (!managed.has(p) && isExcluded(p, excludes)) {
          paths.delete(p)
        }
      }
    }

    return paths
  }

  export async function system() {
    const config = await Config.get()
    const paths = await systemPaths()

    const files = Array.from(paths).map(async (p) => {
      let content = await Filesystem.readText(p).catch(() => "")
      if (content) {
        content = await expandImports(content, p)
      }
      return content ? "Instructions from: " + p + "\n" + content : ""
    })

    const urls: string[] = []
    if (config.instructions) {
      for (const instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
        }
      }
    }
    const fetches = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
    )

    // Load global rules (no path scope)
    const rules = await globalRules()
    const ruleStrings = rules.map((r) => "Rule from: " + r.filepath + "\n" + r.content)

    return Promise.all([...files, ...fetches]).then((result) => [...result.filter(Boolean), ...ruleStrings])
  }

  export function loaded(messages: MessageV2.WithParts[]) {
    const paths = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
          if (part.state.time.compacted) continue
          const loaded = part.state.metadata?.loaded
          if (!loaded || !Array.isArray(loaded)) continue
          for (const p of loaded) {
            if (typeof p === "string") paths.add(p)
          }
        }
      }
    }
    return paths
  }

  export async function find(dir: string) {
    for (const file of FILES) {
      const filepath = path.resolve(path.join(dir, file))
      if (await Filesystem.exists(filepath)) return filepath
    }
  }

  export async function resolve(messages: MessageV2.WithParts[], filepath: string, messageID: string) {
    const system = await systemPaths()
    const already = loaded(messages)
    const results: { filepath: string; content: string }[] = []

    const target = path.resolve(filepath)
    let current = path.dirname(target)
    const root = path.resolve(Instance.directory)

    while (current.startsWith(root) && current !== root) {
      const found = await find(current)

      if (found && found !== target && !system.has(found) && !already.has(found) && !isClaimed(messageID, found)) {
        claim(messageID, found)
        let content = await Filesystem.readText(found).catch(() => undefined)
        if (content) {
          content = await expandImports(content, found)
          results.push({ filepath: found, content: "Instructions from: " + found + "\n" + content })
        }
      }
      // Also check for local variants in this directory
      for (const localFile of LOCAL_FILES) {
        const localPath = path.resolve(path.join(current, localFile))
        if (
          localPath !== target &&
          !system.has(localPath) &&
          !already.has(localPath) &&
          !isClaimed(messageID, localPath)
        ) {
          if (await Filesystem.exists(localPath)) {
            claim(messageID, localPath)
            let content = await Filesystem.readText(localPath).catch(() => undefined)
            if (content) {
              content = await expandImports(content, localPath)
              results.push({ filepath: localPath, content: "Instructions from: " + localPath + "\n" + content })
            }
          }
        }
      }
      current = path.dirname(current)
    }

    return results
  }

  // --- Path-scoped rules ---

  export interface Rule {
    filepath: string
    content: string
    paths?: string[]
  }

  let cachedRules: { global: Rule[]; scoped: Rule[] } | undefined

  export async function loadRules(): Promise<{ global: Rule[]; scoped: Rule[] }> {
    if (cachedRules) return cachedRules

    const globalRules: Rule[] = []
    const scopedRules: Rule[] = []

    const scanDirs: string[] = []
    // Project-level rules
    const projectAboo = path.join(Instance.worktree, ".aboo", "rules")
    const projectClaude = path.join(Instance.worktree, ".claude", "rules")
    if (await Filesystem.exists(projectAboo)) {
      scanDirs.push(projectAboo)
    } else if (await Filesystem.exists(projectClaude)) {
      scanDirs.push(projectClaude)
    }
    // User-level rules
    const userAboo = path.join(os.homedir(), ".aboo", "rules")
    const userClaude = path.join(os.homedir(), ".claude", "rules")
    if (await Filesystem.exists(userAboo)) {
      scanDirs.push(userAboo)
    } else if (await Filesystem.exists(userClaude)) {
      scanDirs.push(userClaude)
    }

    for (const dir of scanDirs) {
      const files = await Glob.scan("**/*.md", {
        cwd: dir,
        absolute: true,
        include: "file",
      }).catch(() => [])

      for (const file of files) {
        try {
          const md = await ConfigMarkdown.parse(file)
          const data = md.data as Record<string, any>
          const rule: Rule = {
            filepath: file,
            content: md.content,
            paths: Array.isArray(data.paths) ? data.paths : data.paths ? [data.paths] : undefined,
          }
          if (rule.paths) {
            scopedRules.push(rule)
          } else {
            globalRules.push(rule)
          }
        } catch (e) {
          log.warn("failed to load rule", { file, error: e })
        }
      }
    }

    cachedRules = { global: globalRules, scoped: scopedRules }
    return cachedRules
  }

  export async function resolveRules(filepath: string, messageID: string): Promise<Rule[]> {
    const rules = await loadRules()
    const matched: Rule[] = []
    const rel = path.relative(Instance.worktree, filepath)

    for (const rule of rules.scoped) {
      if (!rule.paths) continue
      const matches = rule.paths.some((pattern) => minimatch(rel, pattern, { matchBase: true }))
      if (matches && !isClaimed(messageID, rule.filepath)) {
        claim(messageID, rule.filepath)
        matched.push(rule)
      }
    }

    return matched
  }

  export async function globalRules(): Promise<Rule[]> {
    const rules = await loadRules()
    return rules.global
  }
}
