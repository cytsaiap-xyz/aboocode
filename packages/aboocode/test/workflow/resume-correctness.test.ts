import { test, expect } from "bun:test"
import { WorkflowBudget } from "../../src/workflow/budget"
import { WorkflowRun } from "../../src/workflow/run"
import { WorkflowJournal } from "../../src/workflow/journal"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("budget.sub decrements used so invalidated tokens are reclaimed", () => {
  const b = WorkflowBudget.create(100, 80)
  expect(b.remaining()).toBe(20)
  b.sub(40)
  expect(b.remaining()).toBe(60)
  b.add(40)
  expect(b.remaining()).toBe(20)
})

test("a failed journaled call is retried on resume, not returned as its null result (#13)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const SCRIPT = `export const meta = { name: "retry-demo", description: "d" }
const a = await agent("one")
return { a }
`
      const first = await WorkflowRun.execute({
        sessionID: "ses_retry",
        source: SCRIPT,
        scriptPath: "/tmp/retry.js",
        args: undefined,
        // spawn "fails" -> agent() journals { result: null, status: "failed" }
        spawn: async () => null,
      })
      expect(first.status).toBe("done")
      expect(first.value).toEqual({ a: null })

      let resumeSpawnCount = 0
      const resumed = await WorkflowRun.execute({
        sessionID: "ses_retry",
        source: SCRIPT,
        scriptPath: "/tmp/retry.js",
        args: undefined,
        resumeFromRunId: first.runId,
        spawn: async (prompt: string) => {
          resumeSpawnCount++
          return { text: "R(" + prompt + ")", tokens: 1 }
        },
      })
      expect(resumed.status).toBe("done")
      // Must re-run the failed call, not short-circuit to its journaled null result.
      expect(resumeSpawnCount).toBe(1)
      expect(resumed.value).toEqual({ a: "R(one)" })
    },
  })
})

test("budget accounting stays consistent after a schema-failure retry on resume (#11)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const SCRIPT = `export const meta = { name: "budget-reclaim", description: "d" }
const a = await agent("one", { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } })
const b = await agent("two")
let c = null
if (a) c = await agent("three")
return { a, b, c }
`
      const first = await WorkflowRun.execute({
        sessionID: "ses_budget",
        source: SCRIPT,
        scriptPath: "/tmp/budget.js",
        args: undefined,
        budgetTotal: 100,
        spawn: async (prompt: string) => {
          // "one" fails schema parsing but still spends tokens (recorded as a failed row).
          if (prompt === "one") return { text: "not-json", tokens: 90 }
          if (prompt === "two") return { text: "TWO", tokens: 5 }
          throw new Error("unexpected prompt in first run: " + prompt)
        },
      })
      expect(first.status).toBe("done")
      expect(first.value).toEqual({ a: null, b: "TWO", c: null })

      const run = await WorkflowJournal.getRun(first.runId)
      expect(run?.tokens_total).toBe(95)

      // On resume, invalidating from "one" (seq 0) truncates the whole tail — "one" and
      // "two" both re-run (95 tokens freed from the DB). The in-memory budget must be
      // reclaimed by the same 95, or the later fresh "three" call falsely trips the
      // budget guard due to a stale double-count.
      const resumed = await WorkflowRun.execute({
        sessionID: "ses_budget",
        source: SCRIPT,
        scriptPath: "/tmp/budget.js",
        args: undefined,
        budgetTotal: 100,
        resumeFromRunId: first.runId,
        spawn: async (prompt: string) => {
          if (prompt === "one") return { text: `{"ok":true}`, tokens: 10 }
          if (prompt === "two") return { text: "TWO", tokens: 5 }
          if (prompt === "three") return { text: "THREE", tokens: 1 }
          throw new Error("unexpected prompt on resume: " + prompt)
        },
      })

      expect(resumed.status).toBe("done")
      expect(resumed.value).toEqual({ a: { ok: true }, b: "TWO", c: "THREE" })
    },
  })
})

test("workflow() child call is memoized in the parent journal so resume does not re-spawn it (#12)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const childPath = `${tmp.path}/child.js`
      await Bun.write(
        childPath,
        `export const meta = { name: "child", description: "c" }
const r = await agent("inner: " + args.q)
return { r }
`,
      )
      const PARENT = `export const meta = { name: "parent", description: "p" }
const out = await workflow({ scriptPath: ${JSON.stringify(childPath)} }, { q: "hi" })
const b = await agent("after")
return { out, b }
`
      let spawnCount = 0
      const first = await WorkflowRun.execute({
        sessionID: "ses_child",
        source: PARENT,
        scriptPath: "/tmp/parent.js",
        args: undefined,
        spawn: async (prompt: string) => {
          spawnCount++
          return { text: "R(" + prompt + ")", tokens: 1 }
        },
      })
      expect(first.status).toBe("done")
      const spawnsAfterFirst = spawnCount

      const resumed = await WorkflowRun.execute({
        sessionID: "ses_child",
        source: PARENT,
        scriptPath: "/tmp/parent.js",
        args: undefined,
        resumeFromRunId: first.runId,
        spawn: async (prompt: string) => {
          spawnCount++
          return { text: "LIVE(" + prompt + ")", tokens: 1 }
        },
      })
      expect(resumed.status).toBe("done")
      expect(resumed.value).toEqual(first.value)
      // Neither the child's inner agent() call nor the parent's trailing agent()
      // call should re-spawn on resume.
      expect(spawnCount).toBe(spawnsAfterFirst)
    },
  })
})

test("child() callKey distinguishes object-ref workflow targets by scriptPath (#7 memoization fix)", () => {
  const args = { args: { q: "hi" } } as any
  // Old buggy form: `workflow:${ref}` on an object ref stringifies to the same
  // "[object Object]" no matter what scriptPath the ref points at, so two
  // different child scripts collapse onto one callKey and resume would replay
  // the stale child's cached result instead of re-running the new one.
  const buggyKeyA = WorkflowJournal.callKey(0, `workflow:${{ scriptPath: "/a.js" } as any}`, args)
  const buggyKeyB = WorkflowJournal.callKey(0, `workflow:${{ scriptPath: "/b.js" } as any}`, args)
  expect(buggyKeyA).toBe(buggyKeyB)
  expect(buggyKeyA).toBe(WorkflowJournal.callKey(0, "workflow:[object Object]", args))

  // Fixed form: key on the resolved refKey (scriptPath), so different child
  // scripts at the same seq/args produce different callKeys.
  const fixedKeyA = WorkflowJournal.callKey(0, "workflow:/a.js", args)
  const fixedKeyB = WorkflowJournal.callKey(0, "workflow:/b.js", args)
  expect(fixedKeyA).not.toBe(fixedKeyB)
  expect(fixedKeyA).not.toBe(buggyKeyA)
})

test("resume re-runs child workflow when object-ref scriptPath diverges from journaled call (#7)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const childAPath = `${tmp.path}/child-a.js`
      const childBPath = `${tmp.path}/child-b.js`
      await Bun.write(
        childAPath,
        `export const meta = { name: "child-a", description: "a" }
const r = await agent("A: " + args.q)
return { r }
`,
      )
      await Bun.write(
        childBPath,
        `export const meta = { name: "child-b", description: "b" }
const r = await agent("B: " + args.q)
return { r }
`,
      )
      const parentSource = (scriptPath: string) =>
        `export const meta = { name: "parent-divergent", description: "p" }
const out = await workflow({ scriptPath: ${JSON.stringify(scriptPath)} }, { q: "hi" })
return { out }
`

      let spawnCount = 0
      const first = await WorkflowRun.execute({
        sessionID: "ses_child_divergent",
        source: parentSource(childAPath),
        scriptPath: "/tmp/parent-divergent.js",
        args: undefined,
        spawn: async (prompt: string) => {
          spawnCount++
          return { text: "R(" + prompt + ")", tokens: 1 }
        },
      })
      expect(first.status).toBe("done")
      expect(first.value).toEqual({ out: { r: "R(A: hi)" } })
      const spawnsAfterFirst = spawnCount

      // Same seq position, same args — but the parent script now points the child
      // ref at a DIFFERENT scriptPath. Resume must detect the divergence and
      // re-run child-b instead of replaying child-a's cached result.
      const resumed = await WorkflowRun.execute({
        sessionID: "ses_child_divergent",
        source: parentSource(childBPath),
        scriptPath: "/tmp/parent-divergent.js",
        args: undefined,
        resumeFromRunId: first.runId,
        spawn: async (prompt: string) => {
          spawnCount++
          return { text: "LIVE(" + prompt + ")", tokens: 1 }
        },
      })
      expect(resumed.status).toBe("done")
      // Must re-run: a fresh spawn happened, and the result reflects child-b, not
      // the stale child-a cached value.
      expect(spawnCount).toBe(spawnsAfterFirst + 1)
      expect(resumed.value).toEqual({ out: { r: "LIVE(B: hi)" } })
    },
  })
})
