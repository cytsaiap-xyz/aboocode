import { describe, expect, test } from "bun:test"
import { SessionLimits } from "../../src/session/limits"

describe("session.limits.resolveMaxSteps", () => {
  test("uses explicit agent steps when provided", () => {
    expect(SessionLimits.resolveMaxSteps(25)).toBe(25)
  })

  test("falls back to the default cap when unset", () => {
    expect(SessionLimits.resolveMaxSteps(undefined)).toBe(SessionLimits.DEFAULT_MAX_STEPS)
  })

  test("default cap is finite and generous", () => {
    expect(Number.isFinite(SessionLimits.DEFAULT_MAX_STEPS)).toBe(true)
    expect(SessionLimits.DEFAULT_MAX_STEPS).toBeGreaterThanOrEqual(100)
  })
})
