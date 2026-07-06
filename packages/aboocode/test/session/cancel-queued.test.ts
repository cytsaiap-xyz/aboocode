import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// A promise parked in a session's callbacks must be rejected when the session is cancelled,
// not left dangling. We assert on the settle behavior via a direct callbacks injection.
test("cancel rejects queued callbacks instead of leaking them", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Access the internal state through the exported cancel path: build a session entry with a parked callback.
      const rejected = new Promise<string>((_resolve, reject) => {
        SessionPrompt.__test_parkCallback("ses_hang", reject)
      })
      SessionPrompt.cancel("ses_hang")
      await expect(rejected).rejects.toThrow()
    },
  })
})
