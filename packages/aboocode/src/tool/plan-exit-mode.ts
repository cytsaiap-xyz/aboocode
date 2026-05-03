/**
 * ExitPlanMode (mode-toggle counterpart to plan_enter).
 *
 * Phase 13 (closing): symmetric to plan_enter. The existing
 * PlanExitTool is workflow-oriented (asks the user to switch to the
 * build agent); this tool is the simple inverse of plan_enter — it
 * just restores the prior permission mode without altering the agent.
 *
 * Use plan_exit_mode when the model entered plan mode via plan_enter
 * and now wants to resume normal editing without the full PlanExit
 * workflow dialog.
 */

import z from "zod"
import { Tool } from "./tool"
import { PermissionMode } from "../permission/mode"

export const PlanExitModeTool = Tool.define("plan_exit_mode", {
  description: `Exit read-only plan mode and restore the prior permission mode.

This is the symmetric inverse of plan_enter. Use it when you entered plan mode programmatically and want to resume normal editing without the full plan_exit workflow (which prompts the user to switch to the build agent).

Optionally pass a 'restore' mode to set explicitly; default is 'default'.`,
  parameters: z.object({
    restore: z
      .enum(["default", "acceptEdits", "bypassPermissions"])
      .default("default")
      .describe("Mode to restore. Defaults to 'default'."),
    reason: z.string().optional().describe("Why you're exiting plan mode (shown in UI)"),
  }),
  async execute(params, _ctx) {
    const prior: string = PermissionMode.current()
    if (prior !== "plan") {
      return {
        title: "Not in plan mode",
        output: `plan_exit_mode is a no-op when not in plan mode. Current mode: ${prior}.`,
        metadata: { prior, current: prior, changed: false, reason: params.reason },
      }
    }
    PermissionMode.setMode(params.restore)
    return {
      title: `Exited plan mode → ${params.restore}`,
      output: `Plan mode exited; permission mode is now '${params.restore}'.${params.reason ? `\nReason: ${params.reason}` : ""}`,
      metadata: { prior, current: params.restore as string, changed: true, reason: params.reason },
    }
  },
})
