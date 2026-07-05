import { describe, expect, test } from "bun:test"
import { TokenBudget } from "../../src/session/token-budget"

describe("session.token-budget.fromUsage", () => {
  test("sums input, output and cache tokens", () => {
    expect(
      TokenBudget.fromUsage({ input: 1000, output: 200, reasoning: 50, cache: { read: 30_000, write: 500 } }),
    ).toBe(31_700)
  })

  test("zero usage yields zero", () => {
    expect(TokenBudget.fromUsage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBe(0)
  })
})
