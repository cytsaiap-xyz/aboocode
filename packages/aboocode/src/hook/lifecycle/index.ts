/**
 * Public entrypoint for the lifecycle hook subsystem.
 *
 * Usage from other subsystems:
 *
 *   import { HookLifecycle } from "@/hook/lifecycle"
 *
 *   const decision = await HookLifecycle.dispatch({
 *     event: "PreToolUse",
 *     sessionID,
 *     cwd,
 *     timestamp: Date.now(),
 *     tool_name: "Bash",
 *     tool_input: { command: "rm -rf /" },
 *   })
 *   if (decision.decision === "block") throw new ToolBlocked(decision.reason)
 *
 * The event and payload shapes mirror Claude Code's settings.json hook
 * schema so hook configs can be shared between Claude Code and aboocode.
 */

export { HookLifecycle } from "./registry"
export * from "./types"
