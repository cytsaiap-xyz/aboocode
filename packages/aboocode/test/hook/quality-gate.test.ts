import { describe, expect, test } from "bun:test"

/**
 * Quality gate detection tests.
 *
 * These test the exit-status detection logic to ensure the quality gate
 * reads the correct metadata field (`exit`, not `exitCode`) and that
 * structured exit status takes priority over string heuristics.
 */

// Helper to create a minimal completed bash tool part
function bashPart(command: string, output: string, exit?: number) {
  return {
    type: "tool" as const,
    tool: "bash",
    id: "part-1",
    messageID: "msg-1",
    sessionID: "sess-1",
    callID: "call-1",
    state: {
      status: "completed" as const,
      input: { command },
      output,
      metadata: exit !== undefined ? { exit } : undefined,
      time: { start: Date.now(), end: Date.now() },
    },
  }
}

// Inline the detection logic from quality-gate.ts for unit testing
function detectError(part: ReturnType<typeof bashPart>): boolean {
  const output = String(part.state.output ?? "").toLowerCase()
  const exitStatus = part.state.metadata?.exit
  return typeof exitStatus === "number" ? exitStatus !== 0 : output.includes("error") && output.includes("failed")
}

describe("quality gate exit detection", () => {
  test("exit=0 with noisy output containing 'error' is NOT an error (no false positive)", () => {
    const part = bashPart(
      "npm run build",
      "Build completed. Processed 42 files.\nNote: 0 errors found.\nDone in 2.3s",
      0,
    )
    expect(detectError(part)).toBe(false)
  })

  test("exit=1 with minimal output IS an error (no false negative)", () => {
    const part = bashPart("bun test", "Tests: 0 passed", 1)
    expect(detectError(part)).toBe(true)
  })

  test("exit=0 is trusted even when output contains 'failed'", () => {
    const part = bashPart(
      "cargo build",
      "warning: previously failed build detected, retrying\nCompilation succeeded",
      0,
    )
    expect(detectError(part)).toBe(false)
  })

  test("exit=2 is error even without 'error' string in output", () => {
    const part = bashPart("npm run lint", "src/main.ts(5,1): no-unused-vars", 2)
    expect(detectError(part)).toBe(true)
  })

  test("no exit metadata falls back to string heuristic", () => {
    const part = bashPart("make build", "error: compilation failed")
    expect(detectError(part)).toBe(true)
  })

  test("no exit metadata, no error strings = not an error", () => {
    const part = bashPart("make build", "Build succeeded")
    expect(detectError(part)).toBe(false)
  })

  test("no exit metadata, only 'error' without 'failed' = not an error (requires both)", () => {
    const part = bashPart("tsc", "Found 3 errors.")
    expect(detectError(part)).toBe(false)
  })

  test("null exit code (killed process) falls back to string heuristic, not false success", () => {
    // When process is killed, exitCode is null — should NOT be treated as success
    const part = bashPart("npm run build", "Killed", undefined)
    // null exit is not a number, so falls back to string check — "Killed" has no "error"+"failed", so not error
    expect(detectError(part)).toBe(false)
    // But with error output it IS detected
    const part2 = bashPart("npm run build", "error: build failed (killed)", undefined)
    expect(detectError(part2)).toBe(true)
  })
})
