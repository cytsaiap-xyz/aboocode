import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowJournal } from "../../src/workflow/journal"

test("callKey is stable for same inputs and differs when prompt changes", () => {
  const a = WorkflowJournal.callKey(0, "hello", { label: "x" })
  const b = WorkflowJournal.callKey(0, "hello", { label: "x" })
  const c = WorkflowJournal.callKey(0, "world", { label: "x" })
  expect(a).toBe(b)
  expect(a).not.toBe(c)
})

test("record, lookup, and invalidateFrom round-trip through the db", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const runId = await WorkflowJournal.createRun({
        sessionID: "ses_test",
        name: "t",
        scriptPath: "/tmp/s.js",
        model: "anthropic/claude",
        args: { a: 1 },
      })
      const j = WorkflowJournal.bind(runId)
      const key = WorkflowJournal.callKey(0, "p", {})
      await j.record({ seq: 0, callKey: key, prompt: "p", opts: {}, result: { ok: 1 }, tokens: 10, status: "done" })

      const hit = await j.lookup(0)
      expect(hit?.callKey).toBe(key)
      expect(hit?.result).toEqual({ ok: 1 })

      await j.record({ seq: 1, callKey: WorkflowJournal.callKey(1, "q", {}), prompt: "q", opts: {}, result: 2, tokens: 5, status: "done" })
      await j.invalidateFrom(1)
      expect(await j.lookup(1)).toBeUndefined()
      expect(await j.lookup(0)).toBeTruthy()

      const run = await WorkflowJournal.getRun(runId)
      expect(run?.tokens_total).toBe(15)
    },
  })
})
