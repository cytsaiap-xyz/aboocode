/**
 * Permission mode — Claude-Code-compatible global override for permission
 * handling.
 *
 * Modes:
 *   default           — honor the declarative ruleset as usual (current
 *                       aboocode behavior).
 *   acceptEdits       — auto-approve all Write/Edit/NotebookEdit requests;
 *                       everything else still consults the ruleset.
 *   bypassPermissions — auto-approve EVERYTHING. Dangerous; only for
 *                       isolated sandboxes.
 *   plan              — read-only mode. Any permission with side effects
 *                       (write/edit/bash/…) is denied; the model is
 *                       expected to investigate and present a plan.
 *
 * The mode is resolved from:
 *   1. ABOOCODE_PERMISSION_MODE env var
 *   2. CLI --permission-mode=<mode> flag (stored via setMode)
 *   3. session.permission override set by the caller
 *   4. "default"
 */

import { Log } from "@/util/log"

const log = Log.create({ service: "permission.mode" })

export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

const WRITE_LIKE_PERMS = new Set(["write", "edit", "notebook_edit", "apply_patch", "multiedit"])
const SIDE_EFFECT_PERMS = new Set([
  "write",
  "edit",
  "notebook_edit",
  "apply_patch",
  "multiedit",
  "bash",
  "shell",
  "webfetch",
])

let runtimeMode: PermissionMode | undefined

export namespace PermissionMode {
  /**
   * Install the runtime mode (called by the CLI flag parser).
   */
  export function setMode(mode: PermissionMode | undefined): void {
    runtimeMode = mode
    log.info("permission mode set", { mode: mode ?? "default" })
  }

  /**
   * Resolve the effective mode right now.
   */
  export function current(): PermissionMode {
    const env = process.env.ABOOCODE_PERMISSION_MODE as PermissionMode | undefined
    if (env && (PERMISSION_MODES as readonly string[]).includes(env)) return env
    if (runtimeMode) return runtimeMode
    return "default"
  }

  /**
   * Apply the mode's global override to a permission check. Returns:
   *   "allow"   — mode says skip the ruleset and permit
   *   "deny"    — mode says block unconditionally
   *   "fallthrough" — defer to the declarative ruleset
   */
  export function apply(permission: string): "allow" | "deny" | "fallthrough" {
    switch (current()) {
      case "default":
        return "fallthrough"
      case "bypassPermissions":
        return "allow"
      case "acceptEdits":
        return WRITE_LIKE_PERMS.has(permission.toLowerCase()) ? "allow" : "fallthrough"
      case "plan":
        return SIDE_EFFECT_PERMS.has(permission.toLowerCase()) ? "deny" : "fallthrough"
    }
  }
}
