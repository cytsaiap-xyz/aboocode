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
