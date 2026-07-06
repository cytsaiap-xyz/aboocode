import { test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Log } from "../../src/util/log"

// Log.init writes errors.log under Global.Path.log; ABOOCODE_TEST_HOME redirects the data dir.
async function freshHome() {
  const dir = path.join(process.cwd(), ".test-errlog-" + Math.random().toString(36).slice(2))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test("recordError appends a structured line with category and cause chain", async () => {
  await Log.init({ print: false })
  const file = Log.errorFile()
  expect(file).not.toBe("")
  Log.recordError({
    source: "session.error",
    sessionID: "ses_abc",
    category: "model_api_error",
    message: "boom",
    cause: new Error("inner"),
  })
  // Give the append stream a tick to flush.
  await new Promise((r) => setTimeout(r, 50))
  const contents = await fs.readFile(file, "utf8")
  expect(contents).toContain("ses_abc")
  expect(contents).toContain("model_api_error")
  expect(contents).toContain("boom")
})

test("WARN and ERROR log lines are teed to errors.log; DEBUG/INFO are not", async () => {
  await Log.init({ print: false, level: "DEBUG" })
  const file = Log.errorFile()
  const logger = Log.create({ service: "errlog-tee-test" })
  logger.info("an-info-line")
  logger.warn("a-warn-line")
  logger.error("an-error-line")
  await new Promise((r) => setTimeout(r, 50))
  const contents = await fs.readFile(file, "utf8")
  expect(contents).toContain("a-warn-line")
  expect(contents).toContain("an-error-line")
  expect(contents).not.toContain("an-info-line")
})
