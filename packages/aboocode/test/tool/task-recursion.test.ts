import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"

// Mirrors the exact expression used in src/tool/task.ts's recursion guard:
//   const hasTaskPermission =
//     agent.permission.some((rule) => rule.permission === "task") &&
//     PermissionNext.evaluate("task", "*", agent.permission).action !== "deny"
// A revert to the pure `evaluate(...).action !== "deny"` form (the regression)
// would make the default-allow case below assert `true` instead of `false`.
function hasTaskPermission(permission: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]) {
  return (
    permission.some((rule) => rule.permission === "task") &&
    PermissionNext.evaluate("task", "*", permission).action !== "deny"
  )
}

// hasTaskPermission must be false when the agent's effective task action is deny.
test("an agent whose task rule denies is not treated as having task permission", () => {
  const permission = [{ permission: "task", pattern: "*", action: "deny" as const }]
  const hasByPresence = permission.some((rule) => rule.permission === "task")
  const hasByAction = PermissionNext.evaluate("task", "*", permission).action !== "deny"
  expect(hasByPresence).toBe(true) // the OLD (buggy) computation
  expect(hasByAction).toBe(false) // the FIXED computation
})

// REGRESSION GUARD: default shipped agents (build, general) build their permission
// ruleset from `{"*":"allow"}`, which fromConfig expands to a single wildcard rule
// with NO literal "task" permission entry. The buggy fix (`evaluate(...).action !== "deny"`
// alone) matches this wildcard "allow" and incorrectly grants task permission, disabling
// the recursion guard for every default agent (fork-bomb regression). The correct fix
// requires an explicit literal "task" rule in addition to a non-deny effective action.
test("a default *:allow agent (no literal task rule) keeps the recursion guard active", () => {
  const permission = [{ permission: "*", pattern: "*", action: "allow" as const }]
  expect(hasTaskPermission(permission)).toBe(false)
})

test("an agent explicitly granted task:*:allow may recurse", () => {
  const permission = [{ permission: "task", pattern: "*", action: "allow" as const }]
  expect(hasTaskPermission(permission)).toBe(true)
})

test("an agent explicitly denied task:*:deny is blocked from recursing", () => {
  const permission = [{ permission: "task", pattern: "*", action: "deny" as const }]
  expect(hasTaskPermission(permission)).toBe(false)
})
