import { test, expect } from "bun:test"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"

test("cancelPending rejects the in-flight wait for a named server", async () => {
  // Register a wait tagged with an mcp name (registers internally under a
  // random oauthState), then cancel by name — the wait must reject
  // promptly, not linger to the 5-minute timeout.
  const wait = McpOAuthCallback.waitForCallback("test-oauth-state-abc", "my-server")
  McpOAuthCallback.cancelPending("my-server")
  await expect(wait).rejects.toThrow("cancelled")
})

test("cancelPending is a no-op for an unknown server name", async () => {
  // Should not throw when there's no pending wait registered for this name.
  expect(() => McpOAuthCallback.cancelPending("no-such-server")).not.toThrow()
})

test("cancelPending does not affect a differently-named pending wait", async () => {
  const waitA = McpOAuthCallback.waitForCallback("state-a", "server-a")
  const waitB = McpOAuthCallback.waitForCallback("state-b", "server-b")

  McpOAuthCallback.cancelPending("server-a")
  await expect(waitA).rejects.toThrow("cancelled")

  // server-b's wait should still be pending (not rejected by the cancel above).
  McpOAuthCallback.cancelPending("server-b")
  await expect(waitB).rejects.toThrow("cancelled")
})
