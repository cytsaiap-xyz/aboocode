import { test, expect } from "bun:test"
import fs from "fs/promises"
import { Log } from "../../src/util/log"
import { SessionErrorLog } from "../../src/session/error-log"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("a session.error event is written to errors.log with sessionID and error name", async () => {
  await Log.init({ print: false })
  // SessionErrorLog.init() is called unwrapped, exactly as it is at the real process entry
  // points (before any Instance.provide context exists).
  SessionErrorLog.init()

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Bus.publish(Session.Event.Error, {
        sessionID: "ses_bridge",
        error: { name: "ProviderAuthError", data: { message: "auth failed" } } as any,
      })
    },
  })
  await new Promise((r) => setTimeout(r, 50))
  const contents = await fs.readFile(Log.errorFile(), "utf8")
  expect(contents).toContain("ses_bridge")
  expect(contents).toContain("ProviderAuthError")
})

test("SessionErrorLog.init is idempotent (no double-subscribe)", async () => {
  await Log.init({ print: false })
  SessionErrorLog.init()
  SessionErrorLog.init()
  const before = (await fs.readFile(Log.errorFile(), "utf8")).length

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Bus.publish(Session.Event.Error, {
        sessionID: "ses_once",
        error: { name: "UnknownError", data: { message: "x" } } as any,
      })
    },
  })
  await new Promise((r) => setTimeout(r, 50))
  const after = await fs.readFile(Log.errorFile(), "utf8")
  // Exactly one line for ses_once (a double-subscribe would write two).
  const occurrences = after.split("ses_once").length - 1
  expect(occurrences).toBe(1)
  expect(before).toBeLessThanOrEqual(after.length)
})
