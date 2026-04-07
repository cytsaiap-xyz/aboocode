import path from "path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { Global } from "./global"

/**
 * Detailed debug logger for agent team and memory system.
 * Writes human-readable logs to ~/.local/share/aboocode/debug-team-memory.log
 */
export namespace DebugLog {
  const LOG_FILE = "debug-team-memory.log"

  function getLogPath(): string {
    return path.join(Global.Path.log, LOG_FILE)
  }

  function ts(): string {
    return new Date().toISOString()
  }

  function divider(label: string): string {
    const pad = "─".repeat(Math.max(0, 36 - label.length))
    return `\n${"─".repeat(4)} ${label} ${pad}`
  }

  export function log(section: "TEAM" | "MEMORY", operation: string, detail: string): void {
    try {
      const logPath = getLogPath()
      const dir = path.dirname(logPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const line = `[${ts()}] [${section}] ${operation}\n  ${detail.replace(/\n/g, "\n  ")}\n`
      appendFileSync(logPath, line)
    } catch {
      // Fire-and-forget
    }
  }

  export function section(label: string): void {
    try {
      const logPath = getLogPath()
      const dir = path.dirname(logPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      appendFileSync(logPath, `${divider(label)}\n`)
    } catch {
      // Fire-and-forget
    }
  }

  // ── Team-specific helpers ──

  export function teamPlanStarted(sessionID: string, taskSummary: string): void {
    section("TEAM PLANNING")
    log("TEAM", "plan_team", `sessionID: ${sessionID}\ntask: ${taskSummary}`)
  }

  export function teamAgentAdded(sessionID: string, agentId: string, name: string, description: string): void {
    log("TEAM", "add_agent", `sessionID: ${sessionID}\nagent: ${agentId} (${name})\ndescription: ${description}`)
  }

  export function teamFinalized(sessionID: string, agentIds: string[]): void {
    log("TEAM", "finalize_team", `sessionID: ${sessionID}\nagents: [${agentIds.join(", ")}]\ncount: ${agentIds.length}`)
  }

  export function teamDelegateTask(sessionID: string, agentId: string, task: string): void {
    log("TEAM", "delegate_task:start", `sessionID: ${sessionID}\nagent: ${agentId}\ntask: ${task.slice(0, 500)}`)
  }

  export function teamDelegateTaskDone(sessionID: string, agentId: string, status: "success" | "error", output: string): void {
    log(
      "TEAM",
      `delegate_task:${status}`,
      `sessionID: ${sessionID}\nagent: ${agentId}\noutput: ${output.slice(0, 1000)}`,
    )
  }

  export function teamDelegateTasks(sessionID: string, delegations: { agent_id: string; task: string }[]): void {
    const summary = delegations.map((d) => `  - ${d.agent_id}: ${d.task.slice(0, 200)}`).join("\n")
    log("TEAM", "delegate_tasks:start", `sessionID: ${sessionID}\ntasks:\n${summary}`)
  }

  export function teamDelegateTasksDone(sessionID: string, results: Record<string, { status: string; output: string }>): void {
    const summary = Object.entries(results)
      .map(([id, r]) => `  - ${id}: [${r.status}] ${r.output.slice(0, 300)}`)
      .join("\n")
    log("TEAM", "delegate_tasks:done", `sessionID: ${sessionID}\nresults:\n${summary}`)
  }

  export function teamDiscuss(sessionID: string, topic: string, agents: string[]): void {
    log("TEAM", "discuss:start", `sessionID: ${sessionID}\ntopic: ${topic}\nagents: [${agents.join(", ")}]`)
  }

  export function teamDiscussDone(sessionID: string, rounds: number, summary: string): void {
    log("TEAM", "discuss:done", `sessionID: ${sessionID}\nrounds: ${rounds}\nsummary: ${summary.slice(0, 1000)}`)
  }

  export function teamDisbanded(sessionID: string, deletedFiles: string[]): void {
    section("TEAM DISBANDED")
    log("TEAM", "disband_team", `sessionID: ${sessionID}\ndeleted: ${deletedFiles.join(", ") || "(none)"}`)
  }

  export function teamListTeam(sessionID: string, agents: { id: string; name: string }[]): void {
    const list = agents.map((a) => `  - ${a.id}: ${a.name}`).join("\n")
    log("TEAM", "list_team", `sessionID: ${sessionID}\n${list || "  (no agents)"}`)
  }

  // ── Memory-specific helpers ──

  export function memoryInit(): void {
    section("MEMORY SYSTEM INIT")
    log("MEMORY", "init", "Memory system initialized, listening for session idle events")
  }

  export function memoryBuildContext(lineCount: number): void {
    log("MEMORY", "buildContext", `Read MEMORY.md: ${lineCount} lines`)
  }

  export function memoryAppend(noteLength: number, preview: string): void {
    log("MEMORY", "append", `Appending ${noteLength} chars to MEMORY.md\npreview: ${preview.slice(0, 300)}`)
  }

  export function memoryExtractStart(sessionID: string, messageCount: number): void {
    section("MEMORY EXTRACTION")
    log("MEMORY", "extract:start", `sessionID: ${sessionID}\nmessages to process: ${messageCount}`)
  }

  export function memoryExtractSkipped(sessionID: string, reason: string): void {
    log("MEMORY", "extract:skipped", `sessionID: ${sessionID}\nreason: ${reason}`)
  }

  export function memoryExtractDone(sessionID: string, extractedLength: number, preview: string): void {
    log(
      "MEMORY",
      "extract:done",
      `sessionID: ${sessionID}\nextracted: ${extractedLength} chars\npreview: ${preview.slice(0, 500)}`,
    )
  }

  export function memoryStoreRead(filePath: string, contentLength: number): void {
    log("MEMORY", "store:read", `file: ${filePath}\nsize: ${contentLength} chars`)
  }

  export function memoryStoreWrite(filePath: string, contentLength: number): void {
    log("MEMORY", "store:write", `file: ${filePath}\nsize: ${contentLength} chars`)
  }

  /** Write a free-form line to the debug log (observer, etc.) */
  export function line(text: string): void {
    try {
      const logPath = getLogPath()
      const dir = path.dirname(logPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      appendFileSync(logPath, `${text}\n`)
    } catch {
      // Fire-and-forget
    }
  }

  // ── Utility ──

  export function read(): string {
    try {
      const logPath = getLogPath()
      if (!existsSync(logPath)) return ""
      return readFileSync(logPath, "utf-8")
    } catch {
      return ""
    }
  }

  export function clear(): void {
    try {
      const logPath = getLogPath()
      writeFileSync(logPath, `Debug log started at ${ts()}\n\n`)
    } catch {
      // Fire-and-forget
    }
  }

  export function getPath(): string {
    return getLogPath()
  }
}
