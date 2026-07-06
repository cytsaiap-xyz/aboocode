import { test, expect } from "bun:test"
import { SessionRetry } from "../../src/session/retry"

test("delay with headers but no retry-after is capped like the no-headers branch", () => {
  const apiError: any = { name: "APIError", data: { responseHeaders: { "x-request-id": "abc" } } }
  const d = SessionRetry.delay(10, apiError)
  // attempt 10 uncapped would be minutes; the cap keeps it bounded.
  expect(d).toBeLessThanOrEqual(30_000)
})

test("delay honors retry-after-ms", () => {
  const apiError: any = { name: "APIError", data: { responseHeaders: { "retry-after-ms": "5000" } } }
  expect(SessionRetry.delay(1, apiError)).toBe(5000)
})
