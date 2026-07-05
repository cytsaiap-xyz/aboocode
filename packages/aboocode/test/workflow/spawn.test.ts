import { test, expect } from "bun:test"
import { WorkflowSpawn } from "../../src/workflow/spawn"

test("run creates a child session, prompts, and extracts final text + tokens", async () => {
  const calls: any[] = []
  const deps = {
    createSession: async (input: any) => {
      calls.push(["create", input])
      return { id: "ses_child" }
    },
    prompt: async (input: any) => {
      calls.push(["prompt", input])
      return {
        info: { tokens: { output: 42 } },
        parts: [{ type: "text", text: "hello world" }],
      }
    },
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
  }
  const ctx: any = { sessionID: "ses_parent", model: { providerID: "p", modelID: "base" } }
  const res = await WorkflowSpawn.run("do it", { agentType: "general", model: "sonnet" }, ctx, deps)
  expect(res).toEqual({ text: "hello world", tokens: 42 })
  expect(calls[0][1].parentID).toBe("ses_parent")
  expect(calls[1][1].model).toEqual({ providerID: "p", modelID: "sonnet" })
  expect(calls[1][1].agent).toBe("general")
})

test("run returns null when the prompt throws", async () => {
  const deps = {
    createSession: async () => ({ id: "ses_child" }),
    prompt: async () => {
      throw new Error("model error")
    },
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
  }
  const ctx: any = { sessionID: "ses_parent" }
  expect(await WorkflowSpawn.run("x", {}, ctx, deps)).toBeNull()
})

test("abort mid-prompt cancels the child session", async () => {
  const controller = new AbortController()
  const cancelled: string[] = []
  const deps = {
    createSession: async () => ({ id: "ses_child" }),
    prompt: async () => {
      controller.abort()
      await new Promise((r) => setTimeout(r, 5))
      return { info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "late" }] }
    },
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
    cancel: (id: string) => cancelled.push(id),
  }
  const ctx: any = { sessionID: "ses_parent", abort: controller.signal }
  await WorkflowSpawn.run("x", {}, ctx, deps)
  expect(cancelled).toEqual(["ses_child"])
})

test("child sessions get headless permission posture", async () => {
  let created: any
  const deps = {
    createSession: async (input: any) => {
      created = input
      return { id: "ses_child" }
    },
    prompt: async () => ({ info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "ok" }] }),
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
    cancel: () => {},
  }
  await WorkflowSpawn.run("x", {}, { sessionID: "ses_parent" } as any, deps)
  const rule = (perm: string) => created.permission.find((r: any) => r.permission === perm)
  for (const p of ["edit", "write", "bash", "webfetch"]) expect(rule(p)).toEqual({ permission: p, pattern: "*", action: "allow" })
  for (const p of ["todowrite", "todoread", "task", "workflow"]) expect(rule(p)).toEqual({ permission: p, pattern: "*", action: "deny" })
})

test("worktree isolation is created before prompt and released after", async () => {
  const events: string[] = []
  const deps = {
    createSession: async () => ({ id: "ses_child" }),
    prompt: async () => {
      events.push("prompt")
      return { info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "ok" }] }
    },
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
    cancel: () => {},
    isolate: async (id: string) => {
      events.push(`isolate:${id}`)
      return { release: async () => void events.push(`release:${id}`) }
    },
  }
  await WorkflowSpawn.run("x", { isolation: "worktree" }, { sessionID: "ses_parent" } as any, deps)
  expect(events).toEqual(["isolate:ses_child", "prompt", "release:ses_child"])
})

test("no isolation dep call without opts.isolation", async () => {
  let isolated = 0
  const deps = {
    createSession: async () => ({ id: "ses_child" }),
    prompt: async () => ({ info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "ok" }] }),
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
    cancel: () => {},
    isolate: async () => {
      isolated++
      return { release: async () => {} }
    },
  }
  await WorkflowSpawn.run("x", {}, { sessionID: "ses_parent" } as any, deps)
  expect(isolated).toBe(0)
})
