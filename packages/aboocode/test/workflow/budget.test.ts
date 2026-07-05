import { test, expect } from "bun:test"
import { WorkflowBudget } from "../../src/workflow/budget"

test("null total means infinite remaining", () => {
  const b = WorkflowBudget.create(null)
  expect(b.total).toBeNull()
  b.add(1000)
  expect(b.spent()).toBe(1000)
  expect(b.remaining()).toBe(Infinity)
})

test("finite total tracks spend and clamps remaining at 0", () => {
  const b = WorkflowBudget.create(500)
  b.add(200)
  expect(b.remaining()).toBe(300)
  b.add(400)
  expect(b.spent()).toBe(600)
  expect(b.remaining()).toBe(0)
})

test("create seeds prior spend so remaining() is deterministic across resume", () => {
  const b = WorkflowBudget.create(1000, 300)
  expect(b.spent()).toBe(300)
  expect(b.remaining()).toBe(700)
})
