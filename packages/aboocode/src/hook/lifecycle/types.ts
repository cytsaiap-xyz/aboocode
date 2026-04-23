/**
 * Lifecycle hook types — aligned with Claude Code's settings.json hook schema.
 *
 * Reference: claude-code-leak `src/hooks/` and the Claude Code settings
 * documentation (`hooks.PreToolUse`, `hooks.PostToolUse`, etc.).
 *
 * A hook configuration lives in ~/.aboocode/settings.json (or the project-
 * level equivalent) and runs in response to lifecycle events. Each hook can
 * match against a `matcher` regex (for tool-scoped events) and either spawn
 * a shell command or call a registered in-process handler.
 */

import { z } from "zod"

/**
 * The five canonical Claude-Code lifecycle events.
 */
export const LIFECYCLE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
] as const

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number]

export const HookEntry = z.object({
  type: z.enum(["command", "handler"]).default("command"),
  /**
   * For type="command": a shell command invoked with the event payload on
   * stdin (JSON). The command can write `{"decision": "block", "reason": "..."}`
   * to stdout to veto the event; anything else is treated as success.
   */
  command: z.string().optional(),
  /**
   * For type="handler": the name of an in-process handler registered via
   * HookRegistry.register(). Use this for tests and built-in hooks where
   * spawning a shell would be overkill.
   */
  handler: z.string().optional(),
  /** Timeout in milliseconds. Default 30s; hooks exceeding this are killed. */
  timeoutMs: z.number().int().positive().default(30_000),
  /** If true, the event continues even if the hook errors. Default true. */
  continueOnError: z.boolean().default(true),
})

export const HookMatcher = z.object({
  /**
   * Regex (or glob-like literal) matched against the event's primary target.
   * For PreToolUse/PostToolUse → tool name.
   * For UserPromptSubmit       → the first 200 chars of the prompt.
   * For SessionStart/Stop      → session id.
   * A matcher of "*" matches everything.
   */
  matcher: z.string().default("*"),
  hooks: z.array(HookEntry).default([]),
})

export const HookConfig = z.record(z.enum(LIFECYCLE_EVENTS), z.array(HookMatcher).default([])).optional()

export type HookEntryT = z.infer<typeof HookEntry>
export type HookMatcherT = z.infer<typeof HookMatcher>
export type HookConfigT = z.infer<typeof HookConfig>

/**
 * Event payload shared by all lifecycle hooks. Concrete event types extend
 * this with event-specific fields.
 */
export interface HookBasePayload {
  event: LifecycleEvent
  sessionID: string
  /** ms since epoch when the event fired. */
  timestamp: number
  /** project directory the session is running in. */
  cwd: string
}

export interface PreToolUsePayload extends HookBasePayload {
  event: "PreToolUse"
  tool_name: string
  tool_input: unknown
}

export interface PostToolUsePayload extends HookBasePayload {
  event: "PostToolUse"
  tool_name: string
  tool_input: unknown
  tool_response: unknown
}

export interface SessionStartPayload extends HookBasePayload {
  event: "SessionStart"
  source: "startup" | "resume" | "sub-agent"
}

export interface SessionEndPayload extends HookBasePayload {
  event: "SessionEnd"
  reason: string
}

export interface UserPromptSubmitPayload extends HookBasePayload {
  event: "UserPromptSubmit"
  prompt: string
}

export interface StopPayload extends HookBasePayload {
  event: "Stop"
  reason: string
}

export interface SubagentStopPayload extends HookBasePayload {
  event: "SubagentStop"
  subagent: string
  reason: string
}

export interface PreCompactPayload extends HookBasePayload {
  event: "PreCompact"
  strategy: string
}

export interface PostCompactPayload extends HookBasePayload {
  event: "PostCompact"
  strategy: string
  droppedTokens: number
}

export interface NotificationPayload extends HookBasePayload {
  event: "Notification"
  message: string
  level: "info" | "warn" | "error"
}

export type HookPayload =
  | PreToolUsePayload
  | PostToolUsePayload
  | SessionStartPayload
  | SessionEndPayload
  | UserPromptSubmitPayload
  | StopPayload
  | SubagentStopPayload
  | PreCompactPayload
  | PostCompactPayload
  | NotificationPayload

/**
 * Decision returned by a hook. `block` stops the pending action (tool call,
 * prompt, stop) with the provided reason. `modify` overrides the action's
 * input with the provided `modified` payload.
 */
export interface HookDecision {
  decision?: "continue" | "block" | "modify"
  reason?: string
  /** For PreToolUse: replacement tool input. */
  modified?: unknown
}
