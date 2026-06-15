import { test, expect } from "bun:test"
import { WorkflowEngine } from "../../src/workflow/engine"
import { WorkflowConcurrency } from "../../src/workflow/concurrency"
import { WorkflowBudget } from "../../src/workflow/budget"
import type { WorkflowTypes } from "../../src/workflow/types"

function fakeCtx(spawn: WorkflowTypes.SpawnFn, over: Partial<WorkflowTypes.RunContext> = {}): WorkflowTypes.RunContext {
  let seq = 0
  let spawned = 0
  const store = new Map<number, { callKey: string; result: any }>()
  return {
    runId: "wfr_test",
    sessionID: "ses",
    model: undefined,
    args: undefined,
    resume: false,
    depth: 0,
    abort: new AbortController().signal,
    budget: WorkflowBudget.create(null),
    semaphore: new WorkflowConcurrency.Semaphore(4),
    nextSeq: () => seq++,
    guardSpawn: () => {
      spawned++
      if (spawned > 1000) throw new Error("workflow exceeded 1000 agents")
    },
    journal: {
      async lookup(s) {
        return store.get(s)
      },
      async record(e) {
        store.set(e.seq, { callKey: e.callKey, result: e.result })
      },
      async invalidateFrom() {},
    },
    spawn,
    emit: () => {},
    ...over,
  }
}

test("agent returns text and records the call", async () => {
  const g = WorkflowEngine.build(fakeCtx(async (p) => ({ text: "got:" + p, tokens: 3 })))
  expect(await g.agent("hi")).toBe("got:hi")
})

test("agent with schema returns a parsed object", async () => {
  const g = WorkflowEngine.build(fakeCtx(async () => ({ text: `{"n":7}`, tokens: 1 })))
  expect(await g.agent("x", { schema: { type: "object" } })).toEqual({ n: 7 })
})

test("agent returns null on spawn failure (so scripts can filter)", async () => {
  const g = WorkflowEngine.build(fakeCtx(async () => null))
  expect(await g.agent("x")).toBeNull()
})

test("parallel is a barrier and maps thrown thunks to null", async () => {
  const g = WorkflowEngine.build(fakeCtx(async (p) => ({ text: p, tokens: 0 })))
  const out = await g.parallel([() => g.agent("a"), async () => { throw new Error("boom") }, () => g.agent("c")])
  expect(out).toEqual(["a", null, "c"])
})

test("pipeline runs stages per-item with no inter-stage barrier", async () => {
  const g = WorkflowEngine.build(fakeCtx(async (p) => ({ text: p, tokens: 0 })))
  const order: string[] = []
  const out = await g.pipeline(
    ["A", "B"],
    async (item: string) => {
      order.push("s1:" + item)
      if (item === "A") await new Promise((r) => setTimeout(r, 20)) // A is slow in stage 1
      return item
    },
    async (prev: string) => {
      order.push("s2:" + prev)
      return prev.toLowerCase()
    },
  )
  expect(out).toEqual(["a", "b"])
  // B reaches stage 2 before A finishes stage 1 -> no barrier
  expect(order.indexOf("s2:B")).toBeLessThan(order.indexOf("s2:A"))
})

test("budget ceiling makes agent throw once exhausted", async () => {
  const ctx = fakeCtx(async () => ({ text: "x", tokens: 100 }), { budget: WorkflowBudget.create(50) })
  ctx.budget.add(50)
  const g = WorkflowEngine.build(ctx)
  await expect(g.agent("x")).rejects.toThrow(/budget/i)
})

test("resume returns cached result without spawning", async () => {
  let spawnCount = 0
  const ctx = fakeCtx(async (p) => {
    spawnCount++
    return { text: "live:" + p, tokens: 0 }
  })
  // seed the journal as if a prior run completed seq 0
  await ctx.journal.record({ seq: 0, callKey: (await import("../../src/workflow/journal")).WorkflowJournal.callKey(0, "p", {}), prompt: "p", opts: {}, result: "cached", tokens: 0, status: "done" })
  const resumeCtx = { ...ctx, resume: true, nextSeq: (() => { let s = 0; return () => s++ })() }
  const g = WorkflowEngine.build(resumeCtx)
  expect(await g.agent("p")).toBe("cached")
  expect(spawnCount).toBe(0)
})
