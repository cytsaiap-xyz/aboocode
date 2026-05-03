/**
 * Lifecycle hook registry and dispatcher.
 *
 * Ported in spirit from claude-code-leak's `src/hooks/` lifecycle machinery.
 *
 * Responsibilities:
 * - Load hook config from aboocode settings (user, project, env overrides)
 * - Register in-process handlers (used by tests and built-in hooks)
 * - Dispatch lifecycle events to all matching hooks
 * - Spawn command-type hooks with the event payload on stdin
 * - Collect decisions and merge them (block short-circuits, modify overrides
 *   the input for the next hook, continue is the default)
 *
 * Hooks never throw out of dispatch — a failing hook is logged and (per
 * continueOnError) either skipped or converted into a block.
 */

import { spawn } from "child_process"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import {
  type HookConfigT,
  type HookDecision,
  type HookEntryT,
  type HookMatcherT,
  type HookPayload,
  type LifecycleEvent,
  HookConfig,
} from "./types"

const log = Log.create({ service: "hook.lifecycle" })

type Handler = (payload: HookPayload) => Promise<HookDecision | void> | HookDecision | void

const handlers = new Map<string, Handler>()

export namespace HookLifecycle {
  /**
   * Register an in-process hook handler. The returned unregister function
   * removes the handler.
   */
  export function register(name: string, handler: Handler): () => void {
    handlers.set(name, handler)
    return () => {
      if (handlers.get(name) === handler) handlers.delete(name)
    }
  }

  /**
   * Dispatch a lifecycle event to all matching hooks.
   *
   * Hooks run in declaration order. A hook with `decision: "block"` stops
   * dispatch immediately. A hook with `decision: "modify"` replaces the
   * payload for subsequent hooks (PreToolUse only — the caller decides how
   * to apply `modified`).
   */
  export async function dispatch(payload: HookPayload): Promise<HookDecision> {
    const matchers = await loadMatchersFor(payload.event)
    if (matchers.length === 0) return { decision: "continue" }

    let current: HookPayload = payload
    const target = matchTarget(payload)

    // Accumulate additionalContext + last modified input + retry flag across
    // all matching hooks. block short-circuits.
    const additionalContexts: string[] = []
    let lastModified: unknown = undefined
    let retry = false

    for (const matcher of matchers) {
      if (!matchMatcher(matcher.matcher, target)) continue
      for (const entry of matcher.hooks) {
        try {
          const decision = await runHook(entry, current)
          if (!decision) continue

          if (decision.hookSpecificOutput?.additionalContext) {
            additionalContexts.push(decision.hookSpecificOutput.additionalContext)
          }
          if (decision.hookSpecificOutput?.retry) retry = true

          if (decision.decision === "block") {
            log.info("hook blocked event", {
              event: payload.event,
              target,
              reason: decision.reason,
            })
            return {
              ...decision,
              hookSpecificOutput: mergeSpecific(decision, additionalContexts, retry),
            }
          }
          if (decision.decision === "modify" && decision.modified !== undefined) {
            // PreToolUse: swap tool_input for subsequent hooks + return it to
            // the caller so the real tool call uses the modified payload.
            if (current.event === "PreToolUse") {
              current = { ...current, tool_input: decision.modified }
            }
            lastModified = decision.modified
          }
        } catch (e) {
          log.error("hook error", { event: payload.event, entry, error: e })
          if (!entry.continueOnError) {
            return { decision: "block", reason: `hook error: ${String(e)}` }
          }
        }
      }
    }
    const result: HookDecision = { decision: "continue" }
    if (lastModified !== undefined) result.modified = lastModified
    const specific = mergeSpecific({}, additionalContexts, retry)
    if (specific) result.hookSpecificOutput = specific
    return result
  }

  function mergeSpecific(base: HookDecision, contexts: string[], retry: boolean) {
    const merged = { ...(base.hookSpecificOutput ?? {}) }
    if (contexts.length > 0) {
      merged.additionalContext = [merged.additionalContext, ...contexts].filter(Boolean).join("\n\n")
    }
    if (retry) merged.retry = true
    if (Object.keys(merged).length === 0) return undefined
    return merged
  }

  /** Test helper — clears registered in-process handlers. */
  export function _resetForTests() {
    handlers.clear()
  }
}

function matchTarget(payload: HookPayload): string {
  switch (payload.event) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
      return payload.tool_name
    case "UserPromptSubmit":
      return payload.prompt.slice(0, 200)
    case "SessionStart":
    case "SessionEnd":
    case "Stop":
    case "StopFailure":
      return payload.sessionID
    case "SubagentStop":
      return payload.subagent
    case "PreCompact":
    case "PostCompact":
      return payload.strategy
    case "Notification":
      return payload.level
    case "TodoUpdated":
      // Use an aggregate "status" string so matchers can filter on the
      // shape of the todo list (e.g., regex `/in_progress/` to fire only
      // when something is actively running).
      return `total=${payload.summary.total} pending=${payload.summary.pending} in_progress=${payload.summary.in_progress} completed=${payload.summary.completed}`
  }
}

function matchMatcher(pattern: string, target: string): boolean {
  if (pattern === "*" || pattern === "") return true
  try {
    // Interpret as regex by default; fall back to literal substring match
    // if the pattern isn't a valid regex.
    return new RegExp(pattern).test(target)
  } catch {
    return target.includes(pattern)
  }
}

async function loadMatchersFor(event: LifecycleEvent): Promise<HookMatcherT[]> {
  try {
    const config = await Config.get()
    // @ts-expect-error — hooks is additive; older config schemas omit it
    const raw = config.hooks as unknown
    const parsed: HookConfigT | undefined = HookConfig.parse(raw) ?? undefined
    if (!parsed) return []
    return parsed[event] ?? []
  } catch (e) {
    log.warn("hook config invalid, skipping", { error: e })
    return []
  }
}

async function runHook(entry: HookEntryT, payload: HookPayload): Promise<HookDecision | null> {
  if (entry.type === "handler") {
    const handler = entry.handler ? handlers.get(entry.handler) : null
    if (!handler) {
      log.warn("handler hook references unknown handler", { name: entry.handler })
      return null
    }
    const result = await handler(payload)
    return result ?? null
  }

  if (!entry.command) return null
  return await runCommand(entry.command, entry.timeoutMs, payload)
}

async function runCommand(command: string, timeoutMs: number, payload: HookPayload): Promise<HookDecision | null> {
  return await new Promise<HookDecision | null>((resolve) => {
    const child = spawn("sh", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ABOOCODE_HOOK_EVENT: payload.event },
    })
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let finished = false

    const finish = (decision: HookDecision | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(decision)
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      log.warn("hook command timed out", { command, timeoutMs })
      finish({ decision: "block", reason: `hook command timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    child.stdout?.on("data", (chunk) => chunks.push(chunk))
    child.stderr?.on("data", (chunk) => errChunks.push(chunk))
    child.on("error", (e) => {
      log.error("hook command spawn failed", { command, error: e })
      finish({ decision: "continue" })
    })
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim()
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim()
      if (code !== 0) {
        log.warn("hook command non-zero exit", { command, code, stderr })
        finish({ decision: "block", reason: stderr || `hook exited ${code}` })
        return
      }
      if (!stdout) {
        finish({ decision: "continue" })
        return
      }
      try {
        const parsed = JSON.parse(stdout) as HookDecision
        finish(parsed)
      } catch {
        // Non-JSON stdout = continue (advisory only)
        finish({ decision: "continue" })
      }
    })

    child.stdin?.write(JSON.stringify(payload))
    child.stdin?.end()
  })
}
