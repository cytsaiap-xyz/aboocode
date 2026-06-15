import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowRun } from "../../src/workflow/run"
import { WorkflowJournal } from "../../src/workflow/journal"
import { WorkflowEvents } from "../../src/workflow/events"
import { Bus } from "../../src/bus"

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
