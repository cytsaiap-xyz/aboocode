/**
 * EnterPlanMode — switches the session into read-only plan mode.
 *
 * Phase 13: pairs with PlanExitTool. In plan mode, the permission layer
 * denies all side-effect permissions (bash, edit, write, websearch,
 * webfetch) so the model can investigate and design without making
 * changes. Exit the mode via plan_exit to resume normal editing.
 */

import z from "zod"
import { Tool } from "./tool"
import { PermissionMode } from "../permission/mode"

export const PlanEnterTool = Tool.define("plan_enter", {
  description: `Enter read-only plan mode. In this mode, you can investigate and design, but cannot execute Bash, Edit, Write, WebFetch, or WebSearch.

Use when the user asks you to plan before doing, or when a task is complex enough to warrant a design step before implementation.

Call plan_exit when the plan is ready and the user approves moving to implementation.`,
  parameters: z.object({
    reason: z.string().optional().describe("Why you're entering plan mode (shown in UI)"),
  }),
  async execute(params, _ctx) {
    const prior = PermissionMode.current()
    PermissionMode.setMode("plan")
    return {
      title: "Entered plan mode",
      output: `Plan mode active. Side-effect tools (bash, edit, write, webfetch, websearch) are denied until plan_exit.\nPrior mode: ${prior}.${params.reason ? `\nReason: ${params.reason}` : ""}`,
      metadata: { prior, current: "plan", reason: params.reason },
    }
  },
})
