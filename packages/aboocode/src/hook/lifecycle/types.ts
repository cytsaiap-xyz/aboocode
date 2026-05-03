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
 * Canonical Claude-Code lifecycle events.
 *
 * Phase 11 additions:
 *   - PostToolUseFailure — fires after a tool errors out; payload carries
 *     error + error_type. Separate from PostToolUse so hooks can attach
 *     specifically to failures without having to branch on response shape.
 *   - PermissionDenied   — fires when the permission layer rejects a tool
 *     call. A hook can return `{hookSpecificOutput: {retry: true}}` to let
 *     the classifier reconsider (e.g., after writing an allow-rule).
 *   - StopFailure        — fires when Stop itself errors; useful for
 *     reporting shutdown-path failures separately from a graceful Stop.
 */
export const LIFECYCLE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
  // Phase 13.6: TodoWrite emits an observable event so hooks can react
  // to to-do changes (audit trail, external sync, summary banners).
  "TodoUpdated",
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

export interface PostToolUseFailurePayload extends HookBasePayload {
  event: "PostToolUseFailure"
  tool_name: string
  tool_input: unknown
  error: string
  error_type: string
  is_interrupt: boolean
}

export interface PermissionDeniedPayload extends HookBasePayload {
  event: "PermissionDenied"
  tool_name: string
  tool_input: unknown
  permission: string
  reason: string
}

export interface StopFailurePayload extends HookBasePayload {
  event: "StopFailure"
  reason: string
  error: string
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

export interface TodoUpdatedPayload extends HookBasePayload {
  event: "TodoUpdated"
  /** Full snapshot of the todos after the update. */
  todos: Array<{ id?: string; content?: string; status?: string; [k: string]: unknown }>
  /** Counts by status for cheap routing decisions. */
  summary: {
    total: number
    pending: number
    in_progress: number
    completed: number
  }
}

export type HookPayload =
  | PreToolUsePayload
  | PostToolUsePayload
  | PostToolUseFailurePayload
  | PermissionDeniedPayload
  | SessionStartPayload
  | SessionEndPayload
  | UserPromptSubmitPayload
  | StopPayload
  | StopFailurePayload
  | SubagentStopPayload
  | PreCompactPayload
  | PostCompactPayload
  | NotificationPayload
  | TodoUpdatedPayload

/**
 * Decision returned by a hook. `block` stops the pending action (tool call,
 * prompt, stop) with the provided reason. `modify` overrides the action's
 * input with the provided `modified` payload.
 *
 * Phase 11 additions:
 *   - `hookSpecificOutput.additionalContext` — a string the hook wants to
 *     inject as a <system-reminder> in the current turn. The session loop
 *     appends each additionalContext block to the user-message context.
 *   - `hookSpecificOutput.retry` — for PermissionDenied only; signals the
 *     caller to re-evaluate the permission (e.g., hook just persisted a
 *     new allow-rule).
 */
export interface HookDecision {
  decision?: "continue" | "block" | "modify"
  reason?: string
  /** For PreToolUse: replacement tool input. */
  modified?: unknown
  /** Structured per-event output. See HookSpecificOutput. */
  hookSpecificOutput?: HookSpecificOutput
}

export interface HookSpecificOutput {
  /** Prepended as a <system-reminder> on the next user message. */
  additionalContext?: string
  /** PermissionDenied only — re-evaluate the permission after this hook. */
  retry?: boolean
}
