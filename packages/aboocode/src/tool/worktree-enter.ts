/**
 * EnterWorktree — create a git worktree and surface its path + branch.
 *
 * Phase 13: thin wrapper around Worktree.create. The model uses this to
 * spin up an isolated sandbox for risky edits (e.g., a refactor) and
 * later exits via worktree_exit.
 */

import z from "zod"
import { Tool } from "./tool"
import { Worktree } from "../worktree"

export const WorktreeEnterTool = Tool.define("worktree_enter", {
  description: `Create a new git worktree for isolated edits, and return its path + branch.

Use when you need to make changes that should be isolated from the current working tree (e.g., a large refactor the user will review before merging, or parallel agent tasks).

After you are done, call worktree_exit to clean up.`,
  parameters: z.object({
    name: z.string().optional().describe("Optional worktree name; auto-generated if omitted"),
    startCommand: z.string().optional().describe("Optional shell command to run after the worktree is created (e.g., 'bun install')"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "worktree",
      patterns: [params.name ?? "auto"],
      always: ["*"],
      metadata: { action: "create", name: params.name },
    })
    const info = await Worktree.create({ name: params.name, startCommand: params.startCommand })
    return {
      title: `Worktree ${info.name} ready`,
      output: [`Created worktree ${info.name}`, `  branch:    ${info.branch}`, `  directory: ${info.directory}`].join("\n"),
      metadata: { name: info.name, branch: info.branch, directory: info.directory },
    }
  },
})
