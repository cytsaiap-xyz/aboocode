import { test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"

// End-to-end precedence test: project `.aboocode/` config must override home `~/.aboocode/`
// config for a conflicting key, per the documented "local overrides global" priority.
//
// Before the fix, `directories` appended home `~/.aboocode` AFTER project `.aboocode`, and the
// merge loop applies `result = merge(result, loadFile(dir))` in array order (later wins), so
// home silently clobbered project for every conflicting key.
test("project .aboocode config overrides home ~/.aboocode config for the same key", async () => {
  await using homeTmp = await tmpdir({
    init: async (dir) => {
      const homeConfigDir = path.join(dir, ".aboocode")
      await fs.mkdir(homeConfigDir, { recursive: true })
      await Filesystem.write(
        path.join(homeConfigDir, "aboocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "home-user",
        }),
      )
    },
  })

  await using projectTmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const projectConfigDir = path.join(dir, ".aboocode")
      await fs.mkdir(projectConfigDir, { recursive: true })
      await Filesystem.write(
        path.join(projectConfigDir, "aboocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "project-user",
        }),
      )
    },
  })

  const originalTestHome = process.env.ABOOCODE_TEST_HOME
  process.env.ABOOCODE_TEST_HOME = homeTmp.path

  try {
    await Instance.provide({
      directory: projectTmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.username).toBe("project-user")
      },
    })
  } finally {
    process.env.ABOOCODE_TEST_HOME = originalTestHome
  }
})
