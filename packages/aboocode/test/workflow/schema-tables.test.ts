import { test, expect } from "bun:test"
import { WorkflowRunTable, WorkflowAgentCallTable } from "../../src/workflow/workflow.sql"
import { getTableConfig } from "drizzle-orm/sqlite-core"

test("run table has expected columns", () => {
  const cols = getTableConfig(WorkflowRunTable).columns.map((c) => c.name)
  expect(cols).toEqual(
    expect.arrayContaining(["id", "session_id", "name", "script_path", "status", "args_json", "model", "tokens_total"]),
  )
})

test("agent_call table has expected columns", () => {
  const cols = getTableConfig(WorkflowAgentCallTable).columns.map((c) => c.name)
  expect(cols).toEqual(
    expect.arrayContaining(["id", "run_id", "seq", "call_key", "prompt", "opts_json", "result_json", "status", "tokens"]),
  )
})
