import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowRun } from "../../src/workflow/run"
import { WorkflowJournal } from "../../src/workflow/journal"

const SCRIPT = `export const meta = { name: "demo", description: "d", phases: [{ title: "Work" }] }
phase("Work")
const a = await agent("one")
const b = await agent("two")
return { a, b }
`

test("execute runs a script end-to-end and journals each agent call", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let n = 0
      const result = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: SCRIPT,
        scriptPath: "/tmp/demo.js",
        args: undefined,
        spawn: async (prompt: string) => ({ text: "R(" + prompt + ")#" + n++, tokens: 2 }),
      })
      expect(result.status).toBe("done")
      expect(result.value).toEqual({ a: "R(one)#0", b: "R(two)#1" })

      const run = await WorkflowJournal.getRun(result.runId)
      expect(run?.status).toBe("done")
      expect(run?.tokens_total).toBe(4)
    },
  })
})

test("resume replays cached calls without re-spawning", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let spawnCount = 0
      const first = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: SCRIPT,
        scriptPath: "/tmp/demo.js",
        args: undefined,
        spawn: async (prompt: string) => {
          spawnCount++
          return { text: "R(" + prompt + ")", tokens: 1 }
        },
      })
      const before = spawnCount
      const resumed = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: SCRIPT,
        scriptPath: "/tmp/demo.js",
        args: undefined,
        resumeFromRunId: first.runId,
        spawn: async (prompt: string) => {
          spawnCount++
          return { text: "LIVE(" + prompt + ")", tokens: 1 }
        },
      })
      expect(resumed.status).toBe("done")
      expect(resumed.value).toEqual(first.value)
      expect(spawnCount).toBe(before)
    },
  })
})
