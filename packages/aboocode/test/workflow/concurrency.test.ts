import { test, expect } from "bun:test"
import { WorkflowConcurrency } from "../../src/workflow/concurrency"

test("semaphore never exceeds its limit and runs everything", async () => {
  const sem = new WorkflowConcurrency.Semaphore(3)
  let active = 0
  let peak = 0
  let done = 0
  async function work() {
    await sem.acquire()
    try {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      done++
    } finally {
      sem.release()
    }
  }
  await Promise.all(Array.from({ length: 20 }, work))
  expect(peak).toBeLessThanOrEqual(3)
  expect(done).toBe(20)
})

test("create() caps at min(16, cores-2) and at least 1", () => {
  const sem = WorkflowConcurrency.create()
  expect(sem.limit).toBeGreaterThanOrEqual(1)
  expect(sem.limit).toBeLessThanOrEqual(16)
})
