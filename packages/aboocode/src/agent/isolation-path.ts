import path from "path"
import { Instance } from "@/project/instance"
import { AgentIsolation } from "./isolation"

/**
 * Shared path resolver for isolated sessions.
 * All tools should use this instead of Instance.directory / Instance.worktree directly.
 *
 * When a session has a registered IsolationContext (temp, worktree, read_only),
 * paths resolve against the isolated workspace. Otherwise they fall back to the
 * main project workspace — matching the behavior tools had before isolation.
 */
export namespace IsolationPath {
  /**
   * Effective working directory for the session.
   * Falls back to Instance.directory when no isolation context exists.
   */
  export function cwd(sessionID: string): string {
    return AgentIsolation.get(sessionID)?.cwd ?? Instance.directory
  }

  /**
   * Effective project root for the session.
   * Used for computing display-relative paths and permission patterns.
   * Falls back to Instance.worktree when no isolation context exists.
   */
  export function root(sessionID: string): string {
    return AgentIsolation.get(sessionID)?.root ?? Instance.worktree
  }

  /**
   * Resolve a user-supplied path against the session's effective cwd.
   * Absolute paths are returned as-is; relative paths resolve against cwd.
   */
  export function resolve(sessionID: string, input: string): string {
    if (path.isAbsolute(input)) return input
    return path.resolve(cwd(sessionID), input)
  }

  /**
   * Compute a display-relative path against the session's effective root.
   * Used for tool titles and permission pattern display.
   */
  export function relative(sessionID: string, input: string): string {
    return path.relative(root(sessionID), input)
  }

  /**
   * Translate an absolute path from the parent workspace into the
   * session's isolated workspace. Paths outside the parent project
   * are returned unchanged.
   */
  export function translate(sessionID: string, parentPath: string): string {
    const ctx = AgentIsolation.get(sessionID)
    if (!ctx) return parentPath
    return AgentIsolation.translatePath(parentPath, ctx)
  }

  /**
   * Check whether the given path is inside the session's effective root.
   * For shared/read_only sessions without a distinct root, delegates to Instance.containsPath.
   */
  export function contains(sessionID: string, target: string): boolean {
    const ctx = AgentIsolation.get(sessionID)
    if (!ctx || ctx.mode === "shared" || ctx.mode === "read_only") {
      return Instance.containsPath(target)
    }
    // For temp/worktree, the target must be inside the isolated root
    const rel = path.relative(ctx.root, target)
    return !rel.startsWith("..")
  }
}
