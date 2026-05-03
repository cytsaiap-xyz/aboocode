/**
 * ExitWorktree — remove a worktree created via worktree_enter.
 *
 * Phase 13: thin wrapper around Worktree.remove.
 */

import z from "zod"
import { Tool } from "./tool"
import { Worktree } from "../worktree"

export const WorktreeExitTool = Tool.define("worktree_exit", {
  description: `Remove a git worktree that was created with worktree_enter.

Pass the absolute worktree directory (returned by worktree_enter).`,
  parameters: z.object({
    directory: z.string().describe("Absolute path to the worktree, as returned by worktree_enter"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "worktree",
      patterns: [params.directory],
      always: ["*"],
      metadata: { action: "remove", directory: params.directory },
    })
    await Worktree.remove({ directory: params.directory })
    return {
      title: `Removed worktree ${params.directory}`,
      output: `Worktree at ${params.directory} removed.`,
      metadata: { directory: params.directory, removed: true },
    }
  },
})
