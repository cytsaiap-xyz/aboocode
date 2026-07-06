import { test, expect } from "bun:test"
import { WorkflowRun } from "../../src/workflow/run"

// Two concurrent resumes of the same runId: exactly one may proceed; the other must be refused.
test("concurrent resume of the same run is refused for the second caller", async () => {
  // claimResume is the synchronous claim primitive extracted from start().
  const first = WorkflowRun.__claimResume("wfr_dupe")
  const second = WorkflowRun.__claimResume("wfr_dupe")
  expect(first).toBe(true)
  expect(second).toBe(false)
  WorkflowRun.__releaseResume("wfr_dupe")
  expect(WorkflowRun.__claimResume("wfr_dupe")).toBe(true)
  WorkflowRun.__releaseResume("wfr_dupe")
})
