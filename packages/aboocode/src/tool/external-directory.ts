import path from "path"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"
import { IsolationPath } from "../agent/isolation-path"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  // Use isolation-aware containment check when a session context exists.
  // For temp/worktree agents, this checks against the isolated root
  // instead of the parent project, preventing escape via crafted absolute paths.
  if (IsolationPath.contains(ctx.sessionID, target)) return

  // Fallback: also allow if it's within the main project (for shared sessions
  // where IsolationPath.contains delegates to Instance.containsPath anyway,
  // this is a no-op; for isolated sessions, this prevents false positives
  // when tools reference project-level config files).
  if (Instance.containsPath(target)) return

  const kind = options?.kind ?? "file"
  const parentDir = kind === "directory" ? target : path.dirname(target)
  const glob = path.join(parentDir, "*").replaceAll("\\", "/")

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: target,
      parentDir,
    },
  })
}
