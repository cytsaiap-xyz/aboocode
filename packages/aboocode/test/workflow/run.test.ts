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

test("resume refuses a run id that does not exist", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        WorkflowRun.execute({
          sessionID: "ses_demo",
          source: SCRIPT,
          scriptPath: "/tmp/demo.js",
          args: undefined,
          resumeFromRunId: "wfr_nope",
          spawn: async () => ({ text: "x", tokens: 1 }),
        }),
      ).rejects.toThrow("workflow run not found")
    },
  })
})

test("resume resets a stale running row from a crashed process and proceeds", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // A "running" row with no in-process live run models a crashed process.
      const runId = await WorkflowJournal.createRun({
        sessionID: "ses_demo",
        name: "demo",
        scriptPath: "/tmp/demo.js",
        args: undefined,
      })
      const resumed = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: SCRIPT,
        scriptPath: "/tmp/demo.js",
        args: undefined,
        resumeFromRunId: runId,
        spawn: async (prompt: string) => ({ text: "R(" + prompt + ")", tokens: 1 }),
      })
      expect(resumed.status).toBe("done")
      const run = await WorkflowJournal.getRun(runId)
      expect(run?.status).toBe("done")
    },
  })
})

test("resume refuses a run that is live in this process", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let release: () => void = () => {}
      const blocker = new Promise<void>((resolve) => {
        release = resolve
      })
      const { runId, done } = await WorkflowRun.start({
        sessionID: "ses_demo",
        source: SCRIPT,
        scriptPath: "/tmp/demo.js",
        args: undefined,
        spawn: async (prompt: string) => {
          await blocker
          return { text: "R(" + prompt + ")", tokens: 1 }
        },
      })
      await expect(
        WorkflowRun.execute({
          sessionID: "ses_demo",
          source: SCRIPT,
          scriptPath: "/tmp/demo.js",
          args: undefined,
          resumeFromRunId: runId,
          spawn: async () => ({ text: "x", tokens: 1 }),
        }),
      ).rejects.toThrow("still running")
      release()
      const result = await done
      expect(result.status).toBe("done")
    },
  })
})

const CHILD_SCRIPT = `export const meta = { name: "child", description: "c" }
const r = await agent("inner: " + args.q)
return { r }
`

const PARENT_SCRIPT = (childPath: string) => `export const meta = { name: "parent", description: "p" }
const out = await workflow({ scriptPath: ${JSON.stringify(childPath)} }, { q: "hi" })
return out
`

test("workflow() runs a child by scriptPath, sharing the parent budget", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const childPath = `${tmp.path}/child.js`
      await Bun.write(childPath, CHILD_SCRIPT)
      const result = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: PARENT_SCRIPT(childPath),
        scriptPath: "/tmp/parent.js",
        args: undefined,
        budgetTotal: 100,
        spawn: async (prompt: string) => ({ text: "R(" + prompt + ")", tokens: 9 }),
      })
      expect(result.status).toBe("done")
      expect(result.value).toEqual({ r: "R(inner: hi)" })
    },
  })
})

test("workflow() nesting beyond one level throws", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const grandchildPath = `${tmp.path}/gc.js`
      await Bun.write(grandchildPath, CHILD_SCRIPT)
      const childPath = `${tmp.path}/mid.js`
      await Bun.write(
        childPath,
        `export const meta = { name: "mid", description: "m" }
return workflow({ scriptPath: ${JSON.stringify(grandchildPath)} }, { q: "x" })
`,
      )
      const result = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: PARENT_SCRIPT(childPath),
        scriptPath: "/tmp/parent.js",
        args: undefined,
        spawn: async () => ({ text: "t", tokens: 1 }),
      })
      expect(result.status).toBe("failed")
      expect(result.error).toContain("one level")
    },
  })
})

test("aborting a run persists stopped status and journals no interrupted call", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      const result = await WorkflowRun.execute({
        sessionID: "ses_abort",
        source: SCRIPT,
        scriptPath: "/tmp/abort.js",
        args: undefined,
        abort: controller.signal,
        spawn: async (prompt: string) => {
          controller.abort()
          return { text: "partial: " + prompt, tokens: 3 }
        },
      })
      expect(result.status).toBe("stopped")
      const run = await WorkflowJournal.getRun(result.runId)
      expect(run?.status).toBe("stopped")
      expect(run?.tokens_total).toBe(0)
    },
  })
})
