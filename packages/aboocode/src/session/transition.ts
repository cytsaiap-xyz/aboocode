/**
 * Typed transition model for the query loop.
 *
 * Modeled after claude-code-leak/src/query/transitions.ts:
 *   Terminal: why the loop exited (returned).
 *   Continue: why the loop continued to the next iteration.
 *
 * Every break/continue in the outer loop maps to a named reason,
 * making loop behavior auditable and extensible.
 */
export namespace Transition {
  /** Terminal transition — the query loop returned. */
  export type Terminal = {
    type: "terminal"
    reason:
      | "completed" // model finished with end_turn/stop
      | "max_turns" // hit agent.steps limit
      | "aborted_streaming" // abort signal during model streaming
      | "aborted_tools" // abort signal during tool execution
      | "prompt_too_long" // context overflow (unrecoverable after compact)
      | "stop_hook_prevented" // session.stop hook returned block
      | "hook_cancelled" // prompt.submit hook cancelled
      | "model_error" // unrecoverable model/API error
      | "permission_blocked" // permission denied, loop exits
      | "structured_output" // captured structured output
      | "no_user_message" // no user message found (should never happen)
      | "structured_output_missing" // model stopped without calling StructuredOutput
      | (string & {})
    error?: unknown
  }

  /** Continue transition — the loop will iterate again. */
  export type Continue = {
    type: "continue"
    reason:
      | "tool_use" // model returned tool calls
      | "reactive_compact" // context too large, compact and retry
      | "proactive_compact" // approaching limit, compact proactively
      | "max_output_tokens_recovery" // output truncated, inject continue
      | "stop_hook_blocking" // quality gate blocked, injected feedback
      | "background_task_drain" // injected background task notifications
      | "compaction_task" // processing compaction task
      | "subtask" // processing subtask parts
      | "overflow_compact" // overflow detected at finish-step
      | (string & {})
  }

  export type Result = Terminal | Continue

  export function terminal(reason: Terminal["reason"], error?: unknown): Terminal {
    return { type: "terminal", reason, error }
  }

  export function cont(reason: Continue["reason"]): Continue {
    return { type: "continue", reason }
  }
}
