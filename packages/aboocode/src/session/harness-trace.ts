import fs from "fs/promises"
import path from "path"
import { Transition } from "./transition"

/**
 * Harness trace logger — records loop events to a file for verification.
 * Enable with ABOOCODE_HARNESS_TRACE=1 env var.
 * Writes to /tmp/aboocode-harness-trace.jsonl
 */
export namespace HarnessTrace {
  const TRACE_FILE = "/tmp/aboocode-harness-trace.jsonl"
  function enabled() {
    return !!process.env.ABOOCODE_HARNESS_TRACE
  }

  interface TraceEvent {
    ts: string
    sessionID: string
    event: string
    [key: string]: unknown
  }

  async function write(event: TraceEvent) {
    if (!enabled()) return
    const line = JSON.stringify(event) + "\n"
    await fs.appendFile(TRACE_FILE, line).catch(() => {})
  }

  export async function reset() {
    if (!enabled()) return
    await fs.writeFile(TRACE_FILE, "").catch(() => {})
  }

  /** Logged when the main loop starts */
  export function loopStart(sessionID: string, agent: string, model: string) {
    return write({ ts: new Date().toISOString(), sessionID, event: "loop_start", agent, model })
  }

  /** Logged when processor returns a result */
  export function processorResult(sessionID: string, result: Transition.Result) {
    return write({ ts: new Date().toISOString(), sessionID, event: "processor_result", type: result.type, reason: result.reason })
  }

  /** Logged when a tool is executed */
  export function toolExec(sessionID: string, tool: string, status: string) {
    return write({ ts: new Date().toISOString(), sessionID, event: "tool_exec", tool, status })
  }

  /** Logged when isolation path resolves */
  export function isolationResolve(sessionID: string, mode: string, cwd: string, root: string) {
    return write({ ts: new Date().toISOString(), sessionID, event: "isolation_resolve", mode, cwd, root })
  }

  /** Logged when quality gate evaluates */
  export function qualityGate(sessionID: string, action: string, message?: string) {
    return write({ ts: new Date().toISOString(), sessionID, event: "quality_gate", action, message })
  }

  /** Logged when stop hook fires */
  export function stopHook(sessionID: string, action: string) {
    return write({ ts: new Date().toISOString(), sessionID, event: "stop_hook", action })
  }

  /** Logged when the loop ends */
  export function loopEnd(sessionID: string, reason: string) {
    return write({ ts: new Date().toISOString(), sessionID, event: "loop_end", reason })
  }

  /** Logged for output recovery */
  export function outputRecovery(sessionID: string, attempt: number) {
    return write({ ts: new Date().toISOString(), sessionID, event: "output_recovery", attempt })
  }

  /** Logged for compaction */
  export function compaction(sessionID: string, attempt: number) {
    return write({ ts: new Date().toISOString(), sessionID, event: "compaction", attempt })
  }

  /** Logged when session.end hook fires */
  export function sessionEnd(sessionID: string, agent: string, reason: string) {
    return write({ ts: new Date().toISOString(), sessionID, event: "session_end", agent, reason })
  }
}
