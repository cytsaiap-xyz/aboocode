import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ruleset = (entries: Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>) => entries

test("a later denied pattern is enforced even when an earlier pattern only asks", async () => {
  await using tmp = await tmpdir({ config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // "ls" has no rule (defaults to ask); "curl evil" is explicitly denied.
      // The denied pattern comes second — it must still block the whole request.
      const promise = PermissionNext.ask({
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["ls", "curl evil"],
        always: ["ls *", "curl *"],
        ruleset: ruleset([{ permission: "bash", pattern: "curl *", action: "deny" }]),
        metadata: {},
      })
      await expect(promise).rejects.toThrow()
    },
  })
})

test('reply("always") never grants an allow for a config-denied pattern', async () => {
  await using tmp = await tmpdir({ config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Only "ls" is asked (no deny on it); config denies curl. Approving "always"
      // must NOT write an allow for curl into the approved set.
      const rs = ruleset([{ permission: "bash", pattern: "curl *", action: "deny" }])
      const pending = PermissionNext.ask({
        sessionID: "ses_always",
        permission: "bash",
        patterns: ["ls"],
        always: ["ls *", "curl *"],
        ruleset: rs,
        metadata: {},
        id: "per_always",
      })
      await PermissionNext.reply({ requestID: "per_always", reply: "always" })
      await pending
      // curl must still evaluate to deny under config, not allow via approved.
      expect(PermissionNext.evaluate("bash", "curl evil", rs).action).toBe("deny")
    },
  })
})
