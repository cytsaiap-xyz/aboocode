/**
 * Hook-driven permission gate.
 *
 * Sits between the declarative PermissionNext ruleset and the tool
 * dispatcher. For each permission check:
 *
 *   1. Consult PermissionMode (default / acceptEdits / bypassPermissions / plan)
 *      — returns "allow" / "deny" / "fallthrough".
 *   2. If fallthrough, the caller runs its existing ruleset check.
 *
 * This is intentionally separate from the PreToolUse lifecycle hook (which
 * is fired earlier, in session/prompt.ts, over the entire tool call). The
 * PreToolUse hook can block a tool call; the permission gate affects the
 * cheaper permission-ask step inside that tool.
 *
 * Ported in spirit from Claude Code's hook-driven permission check in
 * src/hooks/toolPermission/.
 */

import { PermissionMode } from "./mode"
import type { PermissionNext } from "./next"

export type HookGateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "fallthrough" }

/**
 * Run the hook-driven permission gate for a single permission request.
 * The caller should invoke this BEFORE falling through to the ruleset
 * evaluator. On "fallthrough", the caller runs its existing logic; on
 * "allow", the caller skips the ruleset and returns success; on "deny",
 * the caller throws a DeniedError.
 */
export function gate(request: Pick<PermissionNext.Request, "permission" | "tool">): HookGateDecision {
  const decision = PermissionMode.apply(request.permission)
  switch (decision) {
    case "allow":
      return { kind: "allow" }
    case "deny":
      return { kind: "deny", reason: `permission '${request.permission}' denied by active permission mode` }
    case "fallthrough":
      return { kind: "fallthrough" }
  }
}
