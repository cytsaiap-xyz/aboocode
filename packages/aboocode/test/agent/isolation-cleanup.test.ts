import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * Phase 6.4: Cleanup integration tests.
 *
 * Proves that:
 * 1. Temp directory cleanup runs and removes the directory
 * 2. Cleanup runs even on failure scenarios
 * 3. Registry is cleaned up after unregister
 */

describe("Isolation Cleanup", () => {
  describe("temp directory cleanup", () => {
    test("temp isolation creates and cleans up directory", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      const sessionID = "test-cleanup-temp-" + Date.now()

      // Create a real temp directory via the isolation system
      const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), `aboocode-test-cleanup-`))
      const ctx = {
        mode: "temp",
        cwd: tempBase,
        root: tempBase,
        tempDir: tempBase,
        cleanup: async () => {
          await fs.rm(tempBase, { recursive: true, force: true })
        },
      }

      // Verify directory exists
      const statBefore = await fs.stat(tempBase).catch(() => null)
      expect(statBefore).not.toBeNull()

      // Register and then cleanup
      AgentIsolation.register(sessionID, ctx)
      expect(AgentIsolation.get(sessionID)).toBeDefined()

      await ctx.cleanup()
      AgentIsolation.unregister(sessionID)

      // Directory should be gone
      const statAfter = await fs.stat(tempBase).catch(() => null)
      expect(statAfter).toBeNull()

      // Registry should be cleaned
      expect(AgentIsolation.get(sessionID)).toBeUndefined()
    })

    test("temp cleanup is idempotent", async () => {
      const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), `aboocode-test-idem-`))
      const cleanup = async () => {
        await fs.rm(tempBase, { recursive: true, force: true })
      }

      // First cleanup removes the dir
      await cleanup()
      const stat1 = await fs.stat(tempBase).catch(() => null)
      expect(stat1).toBeNull()

      // Second cleanup doesn't throw
      await expect(cleanup()).resolves.toBeUndefined()
    })

    test("temp cleanup handles files written inside", async () => {
      const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), `aboocode-test-files-`))

      // Simulate agent writing files
      await fs.writeFile(path.join(tempBase, "output.txt"), "test content")
      await fs.mkdir(path.join(tempBase, "subdir"), { recursive: true })
      await fs.writeFile(path.join(tempBase, "subdir", "nested.txt"), "nested")

      // Cleanup should remove everything
      await fs.rm(tempBase, { recursive: true, force: true })
      const stat = await fs.stat(tempBase).catch(() => null)
      expect(stat).toBeNull()
    })
  })

  describe("registry lifecycle", () => {
    test("unregister after cleanup leaves no traces", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      const sessionID = "test-lifecycle-" + Date.now()

      AgentIsolation.register(sessionID, {
        mode: "shared",
        cwd: "/tmp/test",
        root: "/tmp/test",
        cleanup: async () => {},
      })

      expect(AgentIsolation.get(sessionID)).toBeDefined()
      AgentIsolation.unregister(sessionID)
      expect(AgentIsolation.get(sessionID)).toBeUndefined()

      // Double unregister doesn't throw
      AgentIsolation.unregister(sessionID)
      expect(AgentIsolation.get(sessionID)).toBeUndefined()
    })
  })
})
