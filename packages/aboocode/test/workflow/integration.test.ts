import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowRun } from "../../src/workflow/run"
import { WorkflowJournal } from "../../src/workflow/journal"
import { WorkflowEvents } from "../../src/workflow/events"
import { Bus } from "../../src/bus"
import { WorkflowSpawn } from "../../src/workflow/spawn"
import { WorkflowEngine } from "../../src/workflow/engine"

const SCRIPT = `export const meta = { name: "audit", description: "two-phase demo", phases: [{ title: "Find" }, { title: "Verify" }] }
phase("Find")
const found = await parallel([() => agent("scan a"), () => agent("scan b")])
phase("Verify")
const verified = await pipeline(found.filter(Boolean), (f) => agent("verify " + f, { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }))
return { found, verified }
`

test("two-phase workflow runs, emits progress, journals, and resumes from cache", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const events: string[] = []
      const unsub = Bus.subscribe(WorkflowEvents.Progress, (e) => events.push(e.properties.kind))

      let spawnCount = 0
      const fakeSpawn = async (prompt: string) => {
        spawnCount++
        if (prompt.startsWith("verify")) return { text: `{"ok":true}`, tokens: 1 }
        return { text: prompt.toUpperCase(), tokens: 1 }
      }

      const first = await WorkflowRun.execute({
        sessionID: "ses_int",
        source: SCRIPT,
        scriptPath: "/tmp/audit.js",
        args: undefined,
        spawn: fakeSpawn,
      })

      expect(first.status).toBe("done")
      expect(first.value.found).toEqual(["SCAN A", "SCAN B"])
      expect(first.value.verified).toEqual([{ ok: true }, { ok: true }])
      expect(events).toContain("phase")
      expect(events).toContain("agent")

      const run = await WorkflowJournal.getRun(first.runId)
      expect(run?.status).toBe("done")
      expect(run?.tokens_total).toBe(spawnCount)

      const spawnsAfterFirst = spawnCount
      const resumed = await WorkflowRun.execute({
        sessionID: "ses_int",
        source: SCRIPT,
        scriptPath: "/tmp/audit.js",
        args: undefined,
        resumeFromRunId: first.runId,
        spawn: fakeSpawn,
      })
      expect(resumed.status).toBe("done")
      expect(resumed.value).toEqual(first.value)
      expect(spawnCount).toBe(spawnsAfterFirst)

      unsub()
    },
  })
})

const realShapeDeps = (structured: unknown) => ({
  createSession: async () => ({ id: "ses_child" }),
  prompt: async () => ({
    // Real MessageV2.Assistant shape: structured lives on info, text parts are
    // intermediate tool-use narration only — NOT the final JSON answer.
    info: {
      structured,
      tokens: { total: 120, input: 80, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ type: "text", text: "I will now analyze the data..." }],
  }),
  parseModel: (m: string) => ({ providerID: "p", modelID: m }),
  cancel: () => {},
  isolate: async () => ({ release: async () => {} }),
})

test("schema agent reads structured output from info.structured, not text parts", async () => {
  const res = await WorkflowSpawn.run(
    "count bugs",
    { schema: { type: "object", properties: { bugs: { type: "number" } } } },
    { sessionID: "ses_parent" } as any,
    realShapeDeps({ bugs: 3 }),
  )
  expect(res).not.toBeNull()
  expect(JSON.parse(res!.text)).toEqual({ bugs: 3 })
  expect(res!.tokens).toBe(40)
})

test("schema agent through the engine yields the parsed object", async () => {
  const ctx: any = {
    runId: "wfr_i",
    sessionID: "ses_parent",
    args: undefined,
    resume: false,
    depth: 0,
    abort: new AbortController().signal,
    budget: { total: null, spent: () => 0, remaining: () => Infinity, add: () => {} },
    semaphore: { acquire: async () => {}, release: () => {} },
    nextSeq: () => 0,
    guardSpawn: () => {},
    journal: { lookup: async () => undefined, record: async () => {}, invalidateFrom: async () => {} },
    spawn: (p: string, o: any, c: any) => WorkflowSpawn.run(p, o, c, realShapeDeps({ bugs: 3 })),
    emit: () => {},
    child: async () => null,
  }
  const g = WorkflowEngine.build(ctx)
  const value = await g.agent("count bugs", { schema: { type: "object" } })
  expect(value).toEqual({ bugs: 3 })
})

test("schema agent falls back to text-part narration when structured output is missing", async () => {
  const res = await WorkflowSpawn.run(
    "count bugs",
    { schema: { type: "object" } },
    { sessionID: "ses_parent" } as any,
    realShapeDeps(undefined),
  )
  // structured undefined → falls back to text parts, which are narration, not JSON
  expect(res!.text).toBe("I will now analyze the data...")
})
