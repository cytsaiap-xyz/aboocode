# 13. Failure Recovery Pipeline

## 1. Why This Matters

Errors in AI agent systems are inevitable: tool failures, API rate limits, context overflow, model overload, permission denials. In a naive agent, any error terminates the session, forcing the user to restart and re-explain the task.

The failure recovery pipeline classifies errors into types, selects appropriate recovery strategies, and auto-recovers most failures transparently. Errors become decision points, not dead ends.

## 2. Error Classification

### 2.1 Error Types

```typescript
type ErrorType =
  | "tool_input_error"       // Invalid tool arguments (Zod validation failed)
  | "permission_denied"      // User denied or policy blocked
  | "hook_blocked"           // Pre-hook blocked the action
  | "prompt_too_long"        // Context exceeds model limit
  | "max_output_tokens"      // Model output was truncated
  | "model_api_error"        // Provider returned 4xx/5xx
  | "model_overloaded"       // Provider returned 429/529
  | "catastrophic"           // Unrecoverable system error
```

### 2.2 Classification Logic

```python
def classify_error(error):
    if isinstance(error, ZodError) or isinstance(error, ToolInputError):
        return "tool_input_error"

    if isinstance(error, PermissionDeniedError):
        return "permission_denied"

    if isinstance(error, ToolBlockedByHookError):
        return "hook_blocked"

    if isinstance(error, APIError):
        if error.code == "prompt_too_long" or "context_length" in str(error):
            return "prompt_too_long"
        if error.status == 429 or error.status == 529:
            return "model_overloaded"
        return "model_api_error"

    if isinstance(error, MaxOutputTokensError):
        return "max_output_tokens"

    return "catastrophic"
```

## 3. Three Recovery Levels

```
┌─────────────────────────────────────────────────┐
│ Level 1: LIGHT                                    │
│ Strategy: Return error to model as tool result    │
│ Cost: Zero (no extra LLM call)                    │
│                                                   │
│ Applies to:                                       │
│   - tool_input_error                              │
│   - permission_denied                             │
│   - hook_blocked                                  │
├─────────────────────────────────────────────────┤
│ Level 2: MEDIUM                                   │
│ Strategy: System intervention + retry             │
│ Cost: One or more LLM calls                       │
│                                                   │
│ Applies to:                                       │
│   - prompt_too_long → compress context + retry    │
│   - max_output_tokens → inject continue prompt    │
│   - model_overloaded → exponential backoff        │
│   - model_api_error → retry with backoff          │
├─────────────────────────────────────────────────┤
│ Level 3: HEAVY                                    │
│ Strategy: Save state + rebuild or terminate       │
│ Cost: Session disruption                          │
│                                                   │
│ Applies to:                                       │
│   - catastrophic                                  │
│   - repeated medium recovery failures             │
└─────────────────────────────────────────────────┘
```

## 4. Level 1: Light Recovery

### 4.1 Mechanism

Light recovery simply returns the error as a tool result. The model can then adjust its approach:

```python
def light_recovery(error, tool_call):
    return ToolResult(
        error=True,
        content=format_error_for_model(error),
        metadata={
            "errorType": classify_error(error),
            "recoveryLevel": "light",
        }
    )

def format_error_for_model(error):
    if isinstance(error, ToolInputError):
        return (
            f"Tool input validation failed: {error.message}\n"
            f"Expected schema: {error.schema_description}\n"
            f"Please correct the arguments and try again."
        )

    if isinstance(error, PermissionDeniedError):
        return (
            f"Permission denied for tool '{error.tool}': {error.reason}\n"
            f"You may need to use a different approach."
        )

    if isinstance(error, ToolBlockedByHookError):
        return (
            f"Action blocked by policy ({error.blockedBy}): {error.reason}\n"
            f"This action is not permitted. Try an alternative approach."
        )
```

### 4.2 Why This Works

The model is surprisingly good at self-correcting when given clear error messages. For input errors, it typically fixes the arguments on the next turn. For permission denials, it finds alternative approaches.

## 5. Level 2: Medium Recovery

### 5.1 prompt_too_long Recovery

Delegates to the reactive compaction system (Phase 0, Layer 3):

```python
def recover_prompt_too_long(session_id):
    # Aggressive micro-compact
    micro_compact(session_id, keep_recent=2)

    state = recalculate_budget(session_id)
    if state.still_over_limit:
        # Full proactive compact
        proactive_compact(session_id)

    return RecoveryAction.Retry
```

### 5.2 max_output_tokens Recovery (Continuation)

When the model's output is truncated due to hitting max_output_tokens, the system injects a continuation prompt:

```python
MAX_CONTINUATIONS = 3

def recover_max_output_tokens(session_id, truncated_output):
    continuation_count = get_continuation_count(session_id)

    if continuation_count >= MAX_CONTINUATIONS:
        log.warn("Max continuations reached. Accepting truncated output.")
        return RecoveryAction.Accept

    # Inject continuation prompt
    inject_message(session_id, {
        role: "user",
        content: "Continue exactly where you left off.",
        metadata: { type: "continuation_prompt", count: continuation_count + 1 }
    })

    increment_continuation_count(session_id)
    return RecoveryAction.Retry
```

The "Continue exactly where you left off" prompt is deliberately minimal — it gives the model maximum freedom to resume naturally from the truncation point.

**Limit**: Maximum 3 continuations per turn. After that, the truncated output is accepted as-is to prevent infinite loops.

### 5.3 model_overloaded Recovery (Exponential Backoff)

```python
async def recover_model_overloaded(session_id, attempt):
    if attempt >= 5:
        return RecoveryAction.Fail

    # Exponential backoff: 1s, 2s, 4s, 8s, 16s
    delay = min(2 ** attempt, 16)
    log.info(f"Model overloaded. Retrying in {delay}s (attempt {attempt + 1}/5)")
    await sleep(delay)

    return RecoveryAction.Retry
```

### 5.4 model_api_error Recovery

```python
async def recover_model_api_error(session_id, error, attempt):
    if attempt >= 3:
        return RecoveryAction.Escalate  # Escalate to heavy recovery

    # Retry with backoff
    delay = min(2 ** attempt, 8)
    log.warn(f"API error: {error.status}. Retrying in {delay}s")
    await sleep(delay)

    return RecoveryAction.Retry
```

## 6. Level 3: Heavy Recovery

### 6.1 Save and Rebuild

When medium recovery fails repeatedly, the system saves the session state and attempts a full rebuild:

```python
def heavy_recovery(session_id, error):
    # Step 1: Save transcript (preserve everything)
    messages = get_messages(session_id)
    transcript_path = transcript.save(session_id, messages)
    log.error(f"Heavy recovery triggered. Transcript saved: {transcript_path}")

    # Step 2: Attempt rebuild
    try:
        # Clear all messages
        clear_messages(session_id)

        # Rebuild from last good state
        summary = f"Session encountered an error: {error}\n"
        summary += f"Original transcript saved at: {transcript_path}\n"
        summary += "Attempting to continue from last known state."

        inject_message(session_id, {
            role: "system",
            content: summary,
        })

        # Re-inject identity
        set_post_compaction_identity(session_id)

        return RecoveryAction.Retry

    except Exception as rebuild_error:
        # Step 3: Terminate gracefully
        log.error(f"Rebuild failed: {rebuild_error}")
        return RecoveryAction.Terminate
```

### 6.2 Graceful Termination

When all recovery fails:

```python
def terminate_session(session_id, error):
    # Save any unsaved state
    try:
        messages = get_messages(session_id)
        if messages:
            transcript.save(session_id, messages)
    except:
        pass  # Best effort

    # Inform user
    display_error(
        f"Session could not recover from error: {error}\n"
        f"Your conversation has been saved. You can resume with:\n"
        f"  aboocode --resume {session_id}"
    )

    return RecoveryAction.Terminate
```

## 7. Recovery Pipeline Orchestrator

```python
async def handle_error(session_id, error, context):
    error_type = classify_error(error)
    attempt = context.get("attempt", 0)

    # Level 1: Light recovery
    if error_type in ("tool_input_error", "permission_denied", "hook_blocked"):
        return light_recovery(error, context.tool_call)

    # Level 2: Medium recovery
    if error_type == "prompt_too_long":
        return recover_prompt_too_long(session_id)

    if error_type == "max_output_tokens":
        return recover_max_output_tokens(session_id, context.truncated_output)

    if error_type == "model_overloaded":
        return await recover_model_overloaded(session_id, attempt)

    if error_type == "model_api_error":
        action = await recover_model_api_error(session_id, error, attempt)
        if action == RecoveryAction.Escalate:
            return heavy_recovery(session_id, error)
        return action

    # Level 3: Heavy recovery
    if error_type == "catastrophic":
        return heavy_recovery(session_id, error)

    # Unknown error type
    log.error(f"Unknown error type: {error_type}")
    return heavy_recovery(session_id, error)
```

## 8. Data Structures

```typescript
interface RecoveryContext {
  sessionId: string
  error: Error
  errorType: ErrorType
  attempt: number
  toolCall?: ToolCall
  truncatedOutput?: string
}

enum RecoveryAction {
  Retry = "retry",           // Retry the failed operation
  Accept = "accept",         // Accept the partial result
  Escalate = "escalate",     // Escalate to a higher recovery level
  Fail = "fail",             // Give up on this specific operation
  Terminate = "terminate",   // End the session
}

interface RecoveryResult {
  action: RecoveryAction
  message?: string
  toolResult?: ToolResult    // For light recovery
}
```

## 9. Error-to-Recovery Mapping Summary

| Error Type | Recovery Level | Strategy | Max Retries |
|-----------|---------------|----------|-------------|
| tool_input_error | Light | Return error to model | N/A (model self-corrects) |
| permission_denied | Light | Return error to model | N/A |
| hook_blocked | Light | Return error to model | N/A |
| prompt_too_long | Medium | Compress context + retry | 1 |
| max_output_tokens | Medium | Inject continue prompt | 3 |
| model_overloaded | Medium | Exponential backoff | 5 |
| model_api_error | Medium then Heavy | Backoff then rebuild | 3 then 1 |
| catastrophic | Heavy | Save transcript + rebuild/terminate | 1 |

## 10. Acceptance Criteria

- [ ] All 8 error types are correctly classified
- [ ] tool_input_error returns a clear, actionable error message to the model
- [ ] permission_denied does not crash the session
- [ ] prompt_too_long triggers reactive compaction and auto-retries
- [ ] max_output_tokens injects "Continue exactly where you left off" (up to 3 times)
- [ ] model_overloaded uses exponential backoff (1s, 2s, 4s, 8s, 16s)
- [ ] Catastrophic errors save the transcript before terminating
- [ ] Heavy recovery attempts a session rebuild before terminating
- [ ] User is informed with a resume command when the session terminates
- [ ] No error type causes an unhandled exception or silent failure

## 11. Source Files

| File | Responsibility |
|------|------|
| `src/session/recovery.ts` | Error classification, recovery pipeline orchestrator |
| `src/session/processor.ts` | Catches errors in the main loop, delegates to recovery |
| `src/session/compaction.ts` | prompt_too_long recovery (reactive compact) |
| `src/session/prompt.ts` | max_output_tokens continuation injection |

## 12. Product Manager Summary

> Errors are decision points, not dead ends — the system classifies errors, selects recovery strategies, and auto-recovers most failures transparently.
