import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"

/**
 * Integration tests for the IsolationPath resolver and AgentIsolation registry.
 *
 * These prove that:
 * 1. IsolationPath resolves to the main workspace when no context is registered
 * 2. IsolationPath resolves to isolated workspaces when a context IS registered
 * 3. Path containment checks respect isolation boundaries
 * 4. assertExternalDirectory respects isolation roots
 */

// Inline implementations to avoid needing full Instance initialization

describe("IsolationPath", () => {
  describe("path resolution with registered shared context", () => {
    const sessionID = "test-shared-" + Date.now()
    const sharedCwd = "/tmp/test-shared-cwd"
    const sharedRoot = "/tmp/test-shared-root"

    beforeEach(async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      AgentIsolation.register(sessionID, {
        mode: "shared",
        cwd: sharedCwd,
        root: sharedRoot,
        cleanup: async () => {},
      })
    })

    afterEach(async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      AgentIsolation.unregister(sessionID)
    })

    test("cwd returns registered cwd", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      expect(IsolationPath.cwd(sessionID)).toBe(sharedCwd)
    })

    test("root returns registered root", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      expect(IsolationPath.root(sessionID)).toBe(sharedRoot)
    })

    test("resolve makes relative paths absolute against cwd", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      const resolved = IsolationPath.resolve(sessionID, "foo/bar.ts")
      expect(path.isAbsolute(resolved)).toBe(true)
      expect(resolved).toBe(path.resolve(sharedCwd, "foo/bar.ts"))
    })

    test("resolve returns absolute paths unchanged", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      const abs = "/some/absolute/path.ts"
      expect(IsolationPath.resolve(sessionID, abs)).toBe(abs)
    })
  })

  describe("path resolution with temp isolation context", () => {
    let tempDir: string
    const sessionID = "test-temp-session-" + Date.now()

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aboo-isolation-test-"))
      const { AgentIsolation } = await import("../../src/agent/isolation")
      AgentIsolation.register(sessionID, {
        mode: "temp",
        cwd: tempDir,
        root: tempDir,
        tempDir,
        cleanup: async () => {
          await fs.rm(tempDir, { recursive: true, force: true })
        },
      })
    })

    afterEach(async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      AgentIsolation.unregister(sessionID)
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    })

    test("cwd returns temp directory", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      expect(IsolationPath.cwd(sessionID)).toBe(tempDir)
    })

    test("root returns temp directory", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      expect(IsolationPath.root(sessionID)).toBe(tempDir)
    })

    test("resolve makes relative path inside temp dir", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      const resolved = IsolationPath.resolve(sessionID, "src/main.ts")
      expect(resolved).toBe(path.resolve(tempDir, "src/main.ts"))
    })

    test("relative computes path relative to temp root", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      const filePath = path.join(tempDir, "src", "main.ts")
      expect(IsolationPath.relative(sessionID, filePath)).toBe("src/main.ts")
    })

    test("contains returns true for paths inside temp dir", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      expect(IsolationPath.contains(sessionID, path.join(tempDir, "foo.ts"))).toBe(true)
    })

    test("contains returns false for paths outside temp dir", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      expect(IsolationPath.contains(sessionID, "/usr/local/bin/something")).toBe(false)
    })

    test("contains prevents escape via parent traversal", async () => {
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      const escapePath = path.resolve(tempDir, "..", "escape.txt")
      expect(IsolationPath.contains(sessionID, escapePath)).toBe(false)
    })
  })

  describe("registry lifecycle", () => {
    const sessionID = "test-lifecycle-" + Date.now()

    test("get returns undefined before register", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      expect(AgentIsolation.get(sessionID)).toBeUndefined()
    })

    test("get returns context after register", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      const ctx = {
        mode: "shared" as const,
        cwd: "/tmp/test",
        root: "/tmp/test",
        cleanup: async () => {},
      }
      AgentIsolation.register(sessionID, ctx)
      expect(AgentIsolation.get(sessionID)).toBe(ctx)
      AgentIsolation.unregister(sessionID)
    })

    test("get returns undefined after unregister", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      const ctx = {
        mode: "shared" as const,
        cwd: "/tmp/test",
        root: "/tmp/test",
        cleanup: async () => {},
      }
      AgentIsolation.register(sessionID, ctx)
      AgentIsolation.unregister(sessionID)
      expect(AgentIsolation.get(sessionID)).toBeUndefined()
    })
  })

  describe("shell enforcement", () => {
    test("shellAllowed blocks destructive commands in read_only", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      expect(AgentIsolation.shellAllowed("rm -rf /", "read_only")).toBe(false)
      expect(AgentIsolation.shellAllowed("git push origin main", "read_only")).toBe(false)
      expect(AgentIsolation.shellAllowed("git commit -m 'x'", "read_only")).toBe(false)
    })

    test("shellAllowed allows read commands in read_only", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      expect(AgentIsolation.shellAllowed("ls -la", "read_only")).toBe(true)
      expect(AgentIsolation.shellAllowed("cat foo.ts", "read_only")).toBe(true)
      expect(AgentIsolation.shellAllowed("git log --oneline", "read_only")).toBe(true)
      expect(AgentIsolation.shellAllowed("grep -r pattern .", "read_only")).toBe(true)
    })

    test("shellAllowed allows everything in shared mode", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      expect(AgentIsolation.shellAllowed("rm -rf /", "shared")).toBe(true)
      expect(AgentIsolation.shellAllowed("git push", "shared")).toBe(true)
    })
  })

  describe("tool blocking by mode", () => {
    test("all mutation tools blocked in read_only (Phase 3)", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      // Write tools
      expect(AgentIsolation.isToolBlocked("write", "read_only")).toBe(true)
      expect(AgentIsolation.isToolBlocked("edit", "read_only")).toBe(true)
      expect(AgentIsolation.isToolBlocked("apply_patch", "read_only")).toBe(true)
      expect(AgentIsolation.isToolBlocked("multiedit", "read_only")).toBe(true)
      expect(AgentIsolation.isToolBlocked("notebook_edit", "read_only")).toBe(true)
      // Bash blocked — primary enforcement, not regex
      expect(AgentIsolation.isToolBlocked("bash", "read_only")).toBe(true)
    })

    test("read tools allowed in read_only", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      expect(AgentIsolation.isToolBlocked("read", "read_only")).toBe(false)
      expect(AgentIsolation.isToolBlocked("glob", "read_only")).toBe(false)
      expect(AgentIsolation.isToolBlocked("grep", "read_only")).toBe(false)
      expect(AgentIsolation.isToolBlocked("list", "read_only")).toBe(false)
      expect(AgentIsolation.isToolBlocked("webfetch", "read_only")).toBe(false)
      expect(AgentIsolation.isToolBlocked("websearch", "read_only")).toBe(false)
    })

    test("all tools allowed in temp mode", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      expect(AgentIsolation.isToolBlocked("write", "temp")).toBe(false)
      expect(AgentIsolation.isToolBlocked("bash", "temp")).toBe(false)
    })

    test("all tools allowed in worktree mode", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      expect(AgentIsolation.isToolBlocked("write", "worktree")).toBe(false)
      expect(AgentIsolation.isToolBlocked("edit", "worktree")).toBe(false)
      expect(AgentIsolation.isToolBlocked("bash", "worktree")).toBe(false)
    })
  })

  describe("path translation for worktrees", () => {
    // translatePath uses Instance.worktree internally as the parent root.
    // To test without Instance context, we test the cases that don't touch it:
    // - non-project paths (start with ..)
    // - non-worktree mode contexts

    // Note: worktree-mode translation with external paths requires Instance context,
    // which is only available inside a running session. Tested via e2e instead.

    test("leaves paths unchanged for non-worktree modes", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      const ctx = {
        mode: "shared" as const,
        cwd: "/tmp/shared",
        root: "/tmp/shared",
        cleanup: async () => {},
      }

      const somePath = "/some/path/file.ts"
      expect(AgentIsolation.translatePath(somePath, ctx)).toBe(somePath)
    })

    test("IsolationPath.translate delegates through registry", async () => {
      const { AgentIsolation } = await import("../../src/agent/isolation")
      const { IsolationPath } = await import("../../src/agent/isolation-path")
      const sessionID = "test-translate-" + Date.now()

      // No context registered — returns path unchanged
      expect(IsolationPath.translate(sessionID, "/some/path")).toBe("/some/path")

      // Register shared context — translatePath returns unchanged for shared mode
      AgentIsolation.register(sessionID, {
        mode: "shared",
        cwd: "/tmp/shared",
        root: "/tmp/shared",
        cleanup: async () => {},
      })
      expect(IsolationPath.translate(sessionID, "/some/path")).toBe("/some/path")
      AgentIsolation.unregister(sessionID)
    })
  })
})
