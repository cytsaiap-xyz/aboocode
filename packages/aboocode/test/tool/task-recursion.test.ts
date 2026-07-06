import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"

// hasTaskPermission must be false when the agent's effective task action is deny.
test("an agent whose task rule denies is not treated as having task permission", () => {
  const permission = [{ permission: "task", pattern: "*", action: "deny" as const }]
  const hasByPresence = permission.some((rule) => rule.permission === "task")
  const hasByAction = PermissionNext.evaluate("task", "*", permission).action !== "deny"
  expect(hasByPresence).toBe(true) // the OLD (buggy) computation
  expect(hasByAction).toBe(false) // the FIXED computation
})
