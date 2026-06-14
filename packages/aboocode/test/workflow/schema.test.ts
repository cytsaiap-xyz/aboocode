import { test, expect } from "bun:test"
import { WorkflowSchema } from "../../src/workflow/schema"

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }

test("toFormat builds a json_schema output format", () => {
  const f = WorkflowSchema.toFormat(SCHEMA)
  expect(f.type).toBe("json_schema")
  expect(f.schema).toEqual(SCHEMA)
  expect(f.retryCount).toBe(2)
})

test("parseResult parses fenced or raw JSON", () => {
  expect(WorkflowSchema.parseResult(`{"ok":true}`)).toEqual({ ok: true })
  expect(WorkflowSchema.parseResult("```json\n{\"ok\":false}\n```")).toEqual({ ok: false })
})

test("parseResult throws on non-JSON", () => {
  expect(() => WorkflowSchema.parseResult("not json")).toThrow()
})
