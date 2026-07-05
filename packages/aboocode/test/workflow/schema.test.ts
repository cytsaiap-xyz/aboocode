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

test("validateOpts accepts known JSON-serializable opts", () => {
  const opts = { label: "x", phase: "P", model: "sonnet", schema: { type: "object" }, agentType: "general" }
  expect(WorkflowSchema.validateOpts(opts)).toEqual(opts)
})

test("validateOpts rejects unknown keys", () => {
  expect(() => WorkflowSchema.validateOpts({ labell: "typo" })).toThrow("agent() opts invalid")
})

test("validateOpts rejects non-serializable values", () => {
  expect(() => WorkflowSchema.validateOpts({ label: (() => {}) as any })).toThrow("agent() opts invalid")
})
