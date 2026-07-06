import { test, expect } from "bun:test"
import { WorkflowRun } from "../../src/workflow/run"
import { WorkflowJournal } from "../../src/workflow/journal"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

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

// Regression for the leak: start()'s resume claim must be released if the pre-drive
// `setStatus(runId, "running")` throws, since drive()'s finally never gets a chance to run.
test("a throw from the pre-drive setStatus releases the resume claim instead of leaking it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const runId = await WorkflowJournal.createRun({
        sessionID: "ses_leak",
        name: "demo",
        scriptPath: "/tmp/demo.js",
        args: undefined,
      })
      // Move the row out of "running" so the earlier stale-reset setStatus (guarded by its
      // own try/catch) is skipped; only the later, unconditional pre-drive setStatus remains.
      await WorkflowJournal.setStatus(runId, "failed")

      const original = WorkflowJournal.setStatus
      ;(WorkflowJournal as any).setStatus = async (id: string, status: WorkflowJournal.Status) => {
        if (id === runId && status === "running") throw new Error("simulated disk error")
        return original(id, status)
      }
      try {
        await expect(
          WorkflowRun.start({
            sessionID: "ses_leak",
            source: `export const meta = { name: "demo", description: "d" }\nreturn 1\n`,
            scriptPath: "/tmp/demo.js",
            args: undefined,
            resumeFromRunId: runId,
            spawn: async () => ({ text: "x", tokens: 1 }),
          }),
        ).rejects.toThrow("simulated disk error")
      } finally {
        ;(WorkflowJournal as any).setStatus = original
      }

      // The leak: without the fix, runId stays in liveRuns forever and this claim would
      // falsely return false ("still running") even though nothing is running.
      expect(WorkflowRun.__claimResume(runId)).toBe(true)
      WorkflowRun.__releaseResume(runId)
    },
  })
})
