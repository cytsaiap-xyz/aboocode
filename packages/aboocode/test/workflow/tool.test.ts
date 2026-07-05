import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowTool, WorkflowResultFormat } from "../../src/workflow/tool"
import { BackgroundTasks } from "../../src/session/background"

const SCRIPT = `export const meta = { name: "demo", description: "d" }
return "ok"
`

function ctx(): any {
  return {
    sessionID: "ses_tool",
    messageID: "msg_1",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

test("workflow tool validates meta and returns a runId + scriptPath", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await WorkflowTool.init()
      const res = await tool.execute({ script: SCRIPT }, ctx())
      expect(res.metadata.runId).toMatch(/^wfr_/)
      expect(res.metadata.scriptPath).toBeTruthy()
      expect(res.output).toContain(res.metadata.runId)
      // keep the DB open until the background run finishes (avoid teardown races)
      const bg = BackgroundTasks.get(res.metadata.runId)
      if (bg) await bg.promise
    },
  })
})

test("workflow tool rejects a script with no meta", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await WorkflowTool.init()
      await expect(tool.execute({ script: `return 1` }, ctx())).rejects.toThrow(/meta/i)
    },
  })
})

test("background task output includes the run's return value", async () => {
  expect(WorkflowResultFormat.summarize({ runId: "wfr_1", status: "done", value: { bugs: 3 } })).toContain('"bugs": 3')
  expect(WorkflowResultFormat.summarize({ runId: "wfr_1", status: "failed", error: "boom" })).toBe("workflow wfr_1 failed: boom")
})
