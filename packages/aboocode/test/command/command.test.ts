import { test, expect } from "bun:test"
import { Command } from "../../src/command"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("workflow command is registered when experimental.workflows is enabled", async () => {
  await using tmp = await tmpdir({ config: { experimental: { workflows: true } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cmd = await Command.get("workflow")
      expect(cmd).toBeDefined()
      expect(cmd!.source).toBe("command")
      expect(cmd!.hints).toContain("$ARGUMENTS")
      const template = await cmd!.template
      expect(template).toContain("resumeFromRunId")
      expect(template).toContain("scriptPath")
      expect(template).toContain(".aboocode/workflows/")
      expect(template).toContain("do NOT execute")
    },
  })
})

test("workflow command is absent when the flag is off", async () => {
  await using tmp = await tmpdir({ config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cmd = await Command.get("workflow")
      expect(cmd).toBeUndefined()
    },
  })
})

test("workflow command survives Command.reload() when the flag is on", async () => {
  await using tmp = await tmpdir({ config: { experimental: { workflows: true } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Command.reload()
      const cmd = await Command.get("workflow")
      expect(cmd).toBeDefined()
      expect(cmd!.hints).toContain("$ARGUMENTS")
    },
  })
})
