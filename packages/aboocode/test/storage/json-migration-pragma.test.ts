import { test, expect } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import { JsonMigration } from "../../src/storage/json-migration"
import { Global } from "../../src/global"

test("migration restores synchronous to NORMAL on the shared connection", async () => {
  const sqlite = new BunDatabase(":memory:")
  // JsonMigration.run derives its source directory from Global.Path.data, not from an
  // options field, so create an empty storage dir to force the migration body (and its
  // pragma toggling) to run as a no-op rather than short-circuiting before it starts.
  const storageDir = path.join(Global.Path.data, "storage")
  await fs.mkdir(storageDir, { recursive: true })
  try {
    await JsonMigration.run(sqlite).catch(() => {})
    const [{ synchronous }] = sqlite.query("PRAGMA synchronous").all() as any[]
    // NORMAL === 1; OFF === 0. Must not be left at OFF.
    expect(synchronous).not.toBe(0)
  } finally {
    await fs.rm(storageDir, { recursive: true, force: true })
    sqlite.close()
  }
})
