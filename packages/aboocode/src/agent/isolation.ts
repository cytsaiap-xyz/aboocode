import path from "path"
import fs from "fs/promises"
import os from "os"
import type { Agent } from "./agent"
import { Instance } from "@/project/instance"
import { Worktree } from "@/worktree"
import { Log } from "@/util/log"

export namespace AgentIsolation {
  const log = Log.create({ service: "agent.isolation" })

  export type IsolationMode = "shared" | "read_only" | "temp" | "worktree"

  /**
   * Runtime isolation context for an agent session.
   * Created once per task, used by tool execution to determine cwd/root.
   */
  export interface IsolationContext {
    mode: IsolationMode
    /** Effective cwd for the isolated session */
    cwd: string
    /** Root directory (project root, possibly worktree) */
    root: string
    /** If mode === "temp", the temp directory path */
    tempDir?: string
    /** If mode === "worktree", the worktree info */
    worktree?: { name: string; path: string; branch: string }
    /** Cleanup function — call on task completion/abort */
    cleanup: () => Promise<void>
  }

  /**
   * Default isolation modes by agent name/role.
   * Agents not listed here default to "shared".
   */
  const DEFAULT_ISOLATION: Record<string, IsolationMode> = {
    explore: "read_only",
    plan: "read_only",
    verification: "read_only",
    "session-observer": "read_only",
    "memory-extractor": "read_only",
    compaction: "shared",
    summary: "read_only",
    title: "read_only",
    orchestrator: "shared",
    build: "shared",
    general: "shared",
  }

  /**
   * Resolve the effective isolation mode for an agent.
   * Priority: explicit agent.isolation > default by name > "shared"
   */
  export function resolve(agent: Agent.Info): IsolationMode {
    if (agent.isolation) return agent.isolation
    return DEFAULT_ISOLATION[agent.name] ?? "shared"
  }

  /**
   * Create an isolation context for the given mode.
   * This creates real filesystem resources for temp/worktree modes.
   */
  export async function create(mode: IsolationMode, sessionID: string): Promise<IsolationContext> {
    switch (mode) {
      case "shared":
        return {
          mode: "shared",
          cwd: Instance.directory,
          root: Instance.worktree,
          cleanup: async () => {},
        }

      case "read_only":
        return {
          mode: "read_only",
          cwd: Instance.directory,
          root: Instance.worktree,
          cleanup: async () => {},
        }

      case "temp": {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `aboocode-temp-${sessionID.slice(0, 8)}-`))
        log.info("created temp isolation", { sessionID, tempDir })
        return {
          mode: "temp",
          cwd: tempDir,
          root: tempDir,
          tempDir,
          cleanup: async () => {
            try {
              await fs.rm(tempDir, { recursive: true, force: true })
              log.info("cleaned up temp isolation", { sessionID, tempDir })
            } catch (e) {
              log.error("failed to cleanup temp isolation", { sessionID, tempDir, error: e })
            }
          },
        }
      }

      case "worktree": {
        try {
          const wt = await Worktree.create({})
          log.info("created worktree isolation", { sessionID, name: wt.name, directory: wt.directory })
          return {
            mode: "worktree",
            cwd: wt.directory,
            root: wt.directory,
            worktree: { name: wt.name, path: wt.directory, branch: wt.branch },
            cleanup: async () => {
              try {
                await Worktree.remove({ directory: wt.directory })
                log.info("cleaned up worktree isolation", { sessionID, name: wt.name })
              } catch (e) {
                log.warn("failed to cleanup worktree — may have uncommitted changes", {
                  sessionID,
                  name: wt.name,
                  error: e,
                })
              }
            },
          }
        } catch (e) {
          log.warn("worktree creation failed, falling back to shared", { sessionID, error: e })
          return {
            mode: "shared",
            cwd: Instance.directory,
            root: Instance.worktree,
            cleanup: async () => {},
          }
        }
      }
    }
  }

  /**
   * Check if the given tool should be blocked under the given isolation mode.
   *
   * For read_only: blocks ALL mutation tools including bash.
   * This is the primary enforcement layer (Phase 3 of harness alignment).
   * The regex in shellAllowed() remains as defense-in-depth only.
   */
  export function isToolBlocked(tool: string, mode: IsolationMode): boolean {
    switch (mode) {
      case "read_only": {
        const blockedTools = new Set(["write", "edit", "apply_patch", "multiedit", "bash", "notebook_edit"])
        return blockedTools.has(tool)
      }
      case "temp":
        // Temp mode allows writes but only within temp directory
        // Path enforcement happens in the tool execution via IsolationContext.cwd
        return false
      case "worktree":
        // Worktree mode allows all tools in the worktree directory
        return false
      case "shared":
        return false
      default:
        return false
    }
  }

  /**
   * Defense-in-depth check for shell commands under read_only mode.
   *
   * NOTE: This is NOT the primary enforcement layer. The primary enforcement
   * is isToolBlocked() which completely blocks bash for read_only agents.
   * This regex check remains as a secondary safety net in case bash access
   * is explicitly re-enabled for a read_only agent via custom permissions.
   */
  export function shellAllowed(command: string, mode: IsolationMode): boolean {
    if (mode !== "read_only") return true
    const destructive = /\b(rm|mv|cp|mkdir|touch|chmod|chown|ln|git\s+(push|commit|merge|rebase|checkout|reset|clean))\b/
    return !destructive.test(command)
  }

  /**
   * Translate a path from parent context to the isolation context.
   * Used when worktree agents receive file paths from the parent.
   */
  export function translatePath(parentPath: string, ctx: IsolationContext): string {
    if (ctx.mode !== "worktree" || !ctx.worktree) return parentPath
    const rel = path.relative(Instance.worktree, parentPath)
    if (rel.startsWith("..")) return parentPath // outside project
    return path.join(ctx.root, rel)
  }

  // Registry of active isolation contexts by session ID.
  // Used by prompt.ts to resolve cwd/root for isolated sessions.
  const contexts = new Map<string, IsolationContext>()

  /** Register an isolation context for a session. */
  export function register(sessionID: string, ctx: IsolationContext) {
    contexts.set(sessionID, ctx)
  }

  /** Unregister an isolation context for a session. */
  export function unregister(sessionID: string) {
    contexts.delete(sessionID)
  }

  /** Get the isolation context for a session, if any. */
  export function get(sessionID: string): IsolationContext | undefined {
    return contexts.get(sessionID)
  }

  /**
   * Map a team role to an isolation mode.
   */
  export function fromRole(role: string): IsolationMode {
    switch (role) {
      case "explore":
      case "plan":
        return "read_only"
      case "verify":
        return "read_only"
      case "implement":
        return "shared"
      default:
        return "shared"
    }
  }
}
