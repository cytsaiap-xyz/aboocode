import { test, expect } from "bun:test"
import { WorkflowRuntime } from "../../src/workflow/runtime"

const META = `export const meta = { name: "t", description: "d", phases: [{ title: "P" }] }\n`

test("parseMeta extracts the literal", () => {
  const meta = WorkflowRuntime.parseMeta(META + "log('hi')")
  expect(meta.name).toBe("t")
  expect(meta.description).toBe("d")
  expect(meta.phases?.[0].title).toBe("P")
})

test("parseMeta throws when meta missing required fields", () => {
  expect(() => WorkflowRuntime.parseMeta(`export const meta = { name: "x" }\n`)).toThrow()
})

test("evaluate runs the body and returns its value, with globals injected", async () => {
  const calls: string[] = []
  const globals = {
    log: (m: string) => calls.push(m),
    agent: async (p: string) => "R:" + p,
  }
  const result = await WorkflowRuntime.evaluate(META + `log("a"); return await agent("x")`, globals)
  expect(calls).toEqual(["a"])
  expect(result).toBe("R:x")
})

test("determinism guards throw", async () => {
  await expect(WorkflowRuntime.evaluate(META + `return Date.now()`, {})).rejects.toThrow(/deterministic/i)
  await expect(WorkflowRuntime.evaluate(META + `return Math.random()`, {})).rejects.toThrow(/deterministic/i)
  await expect(WorkflowRuntime.evaluate(META + `return new Date().getTime()`, {})).rejects.toThrow(/deterministic/i)
})

test("host capabilities are absent from scope", async () => {
  await expect(WorkflowRuntime.evaluate(META + `return typeof require`, {})).resolves.toBe("undefined")
  await expect(WorkflowRuntime.evaluate(META + `return typeof process`, {})).resolves.toBe("undefined")
  await expect(WorkflowRuntime.evaluate(META + `return typeof fetch`, {})).resolves.toBe("undefined")
})

test("parseMeta handles braces inside string values", () => {
  const meta = WorkflowRuntime.parseMeta(`export const meta = { name: "n", description: "use { and } here" }\n` + "log('x')")
  expect(meta.description).toBe("use { and } here")
})

test("deterministic Date statics are allowed", async () => {
  const META = `export const meta = { name: "t", description: "d" }\n`
  await expect(WorkflowRuntime.evaluate(META + `return Date.parse("2024-01-01T00:00:00Z")`, {})).resolves.toBe(1704067200000)
  await expect(WorkflowRuntime.evaluate(META + `return Date.UTC(2024,0,1)`, {})).resolves.toBe(1704067200000)
})
