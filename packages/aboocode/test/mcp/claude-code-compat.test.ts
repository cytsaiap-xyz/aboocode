import { test, expect } from "bun:test"
import { convert } from "../../src/mcp/claude-code-compat"

test("SSE and HTTP Claude Code servers convert to remote so MCP.create can connect them", () => {
  const sse = convert({ type: "sse", url: "https://x/sse" })
  expect(sse?.type).toBe("remote")
  expect(sse?.url).toBe("https://x/sse")

  const http = convert({ type: "http", url: "https://x/mcp", headers: { a: "b" } })
  expect(http?.type).toBe("remote")
  expect(http?.headers).toEqual({ a: "b" })
})
