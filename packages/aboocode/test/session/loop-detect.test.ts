import { describe, expect, test } from "bun:test"
import { LoopDetect } from "../../src/session/loop-detect"

const read = (path: string) => ({ tool: "read", input: { filePath: path } })
const bash = (cmd: string) => ({ tool: "bash", input: { command: cmd } })

describe("session.loop-detect.repeated", () => {
  test("catches consecutive identical calls", () => {
    const calls = [read("/a"), read("/a"), read("/a")]
    expect(LoopDetect.repeated(calls)?.tool).toBe("read")
  })

  test("catches alternating loops within the window", () => {
    const calls = [read("/a"), bash("ls"), read("/a"), bash("ls"), read("/a")]
    expect(LoopDetect.repeated(calls)?.tool).toBe("read")
  })

  test("ignores repeats outside the window", () => {
    const calls: { tool: string; input: unknown }[] = [read("/a"), read("/a")]
    for (let i = 0; i < LoopDetect.WINDOW; i++) calls.push(bash(`step ${i}`))
    calls.push(read("/a"))
    expect(LoopDetect.repeated(calls)).toBeUndefined()
  })

  test("distinct inputs never trigger", () => {
    const calls = [read("/a"), read("/b"), read("/c"), read("/d")]
    expect(LoopDetect.repeated(calls)).toBeUndefined()
  })

  test("stale repeats of another tool do not mask the current call's loop", () => {
    const calls = [read("/a"), read("/a"), read("/a"), bash("ls"), bash("ls"), bash("ls")]
    expect(LoopDetect.repeated(calls)?.tool).toBe("bash")
  })

  test("returns undefined when only an earlier tool repeated, not the current call", () => {
    const calls = [read("/a"), read("/a"), read("/a"), bash("ls")]
    expect(LoopDetect.repeated(calls)).toBeUndefined()
  })
})
