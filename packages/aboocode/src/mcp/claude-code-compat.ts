/**
 * Claude Code `.mcp.json` compatibility loader.
 *
 * Reads a Claude Code `.mcp.json` (project-level) or `~/.claude.json`
 * (user-level) config file and converts each `mcpServers.<name>` entry
 * into an aboocode `Config.Mcp` entry so the existing MCP connect path
 * can use it unchanged.
 *
 * This closes a portability gap — users who already have Claude Code MCP
 * servers configured can point aboocode at the same file without
 * re-authoring.
 *
 * The `.mcp.json` schema from Claude Code looks like:
 *   {
 *     "mcpServers": {
 *       "myserver": {
 *         "type": "stdio" | "sse" | "http" | "streamable",
 *         "command": "node",
 *         "args": ["server.js"],
 *         "env": {...},
 *         "url": "https://...",
 *         "headers": {...}
 *       }
 *     }
 *   }
 */

import { readFile } from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "mcp.claude-code-compat" })

/**
 * Minimal shape compatible with aboocode's Config.Mcp discriminated union.
 * We return this as an unknown-keyed record so the caller can merge into
 * the live Config.Info.mcp without importing the full zod schema here.
 */
export interface CompatMcpEntry {
  type: "local" | "remote" | "sse" | "http"
  enabled?: boolean
  command?: string[]
  environment?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

interface ClaudeCodeMcpServer {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

interface ClaudeCodeMcpConfig {
  mcpServers?: Record<string, ClaudeCodeMcpServer>
}

/**
 * Resolve the `.mcp.json` path to try. Order:
 *   1. ABOOCODE_MCP_JSON env var (explicit override)
 *   2. <projectDir>/.mcp.json (project-level)
 *   3. <home>/.mcp.json (user-level)
 *   4. <home>/.claude.json (Claude Code's user file)
 */
export function candidatePaths(projectDir: string): string[] {
  const paths: string[] = []
  if (process.env.ABOOCODE_MCP_JSON) paths.push(process.env.ABOOCODE_MCP_JSON)
  paths.push(path.join(projectDir, ".mcp.json"))
  paths.push(path.join(Global.Path.home, ".mcp.json"))
  paths.push(path.join(Global.Path.home, ".claude.json"))
  return paths
}

/**
 * Convert a single Claude Code MCP server entry to aboocode's CompatMcpEntry
 * shape. Returns null if the entry is unrecognizable.
 */
function convert(entry: ClaudeCodeMcpServer): CompatMcpEntry | null {
  const rawType = (entry.type ?? "stdio").toLowerCase()
  if (rawType === "stdio" || (!entry.type && entry.command)) {
    if (!entry.command) return null
    return {
      type: "local",
      command: [entry.command, ...(entry.args ?? [])],
      environment: entry.env,
    }
  }
  if (rawType === "sse") {
    if (!entry.url) return null
    return { type: "sse", url: entry.url, headers: entry.headers }
  }
  if (rawType === "http" || rawType === "streamable" || rawType === "streamable-http") {
    if (!entry.url) return null
    return { type: "http", url: entry.url, headers: entry.headers }
  }
  log.warn("unrecognized mcp entry type", { type: rawType })
  return null
}

/**
 * Load and parse a Claude Code `.mcp.json`-style file. Returns an empty
 * map on any error.
 */
export async function loadFromFile(filepath: string): Promise<Record<string, CompatMcpEntry>> {
  try {
    const raw = await readFile(filepath, "utf-8")
    const parsed = JSON.parse(raw) as ClaudeCodeMcpConfig
    if (!parsed.mcpServers) return {}
    const result: Record<string, CompatMcpEntry> = {}
    for (const [name, server] of Object.entries(parsed.mcpServers)) {
      const converted = convert(server)
      if (converted) result[name] = converted
    }
    return result
  } catch (e) {
    // Silent miss — most projects won't have a .mcp.json
    log.debug("no mcp.json at path", { filepath, error: (e as Error).message })
    return {}
  }
}

/**
 * Try each candidate path in order and return the first non-empty
 * config, or an empty map if none are found.
 */
export async function loadFirst(projectDir: string): Promise<Record<string, CompatMcpEntry>> {
  for (const candidate of candidatePaths(projectDir)) {
    const entries = await loadFromFile(candidate)
    if (Object.keys(entries).length > 0) {
      log.info("loaded .mcp.json compat config", { path: candidate, count: Object.keys(entries).length })
      return entries
    }
  }
  return {}
}
