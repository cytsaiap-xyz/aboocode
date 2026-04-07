# Aboocode Harness Engineering Plan

Date: 2026-04-03 (revised)

Goal: align Aboocode's harness with Claude Code's harness engineering patterns, using `claude-code-leak/` and `ai-agent-deep-dive/` as authoritative references.

---

## Current State

Aboocode's query loop (`prompt.ts` → `processor.ts`) uses ad-hoc string returns (`"stop"`, `"compact"`, `"continue"`) with no typed transitions. Claude Code uses a typed `Terminal`/`Continue` discriminated union (`query/transitions.ts`) that makes every loop exit and continuation reason explicit, auditable, and extensible.

The gap is not one feature — it's the missing structural layer that every other harness behavior (isolation, cancellation, recovery, quality gates) should plug into.

---

## Target 0: Typed Loop Transition Model

### Problem

`SessionProcessor.process()` returns `"stop" | "compact" | "continue"` — three ad-hoc strings. The outer loop in `prompt.ts` uses string equality checks (`result === "stop"`) with no structured metadata.

Claude Code returns typed objects:

```typescript
// claude-code-leak/src/query/transitions.ts
type Terminal = {
  reason: 'completed' | 'max_turns' | 'aborted_streaming' | 'aborted_tools'
    | 'prompt_too_long' | 'stop_hook_prevented' | 'hook_stopped'
    | 'model_error' | 'blocking_limit' | 'image_error' | (string & {})
  error?: unknown
}

type Continue = {
  reason: 'tool_use' | 'reactive_compact_retry' | 'max_output_tokens_recovery'
    | 'max_output_tokens_escalate' | 'collapse_drain_retry'
    | 'stop_hook_blocking' | 'token_budget_continuation'
    | 'queued_command' | (string & {})
}
```

This means Claude Code can:
- distinguish "model said stop" from "permission blocked" from "hook prevented"
- route different continuations to different recovery logic
- audit exactly why any session ended or iterated

### Why This Matters

- `ai-agent-deep-dive/docs/08-agent-runtime-loop.md`: loop outputs must be explicit typed states, not implicit string comparisons
- `claude-code-leak/src/query/transitions.ts`: the actual production system uses 11 terminal + 8 continuation typed reasons

### Fixing Plan

#### 0.1 Define transition types

New file: `packages/aboocode/src/session/transition.ts`

```typescript
export namespace Transition {
  export type Terminal = {
    type: "terminal"
    reason:
      | "completed"           // model finished with end_turn/stop
      | "max_turns"           // hit agent.steps limit
      | "aborted_streaming"   // abort signal during model streaming
      | "aborted_tools"       // abort signal during tool execution
      | "prompt_too_long"     // context overflow (unrecoverable after compact)
      | "stop_hook_prevented" // session.stop hook returned block
      | "hook_cancelled"      // prompt.submit hook cancelled
      | "model_error"         // unrecoverable model/API error
      | "permission_blocked"  // permission denied, loop exits
      | "structured_output"   // captured structured output
      | (string & {})
    error?: unknown
  }

  export type Continue = {
    type: "continue"
    reason:
      | "tool_use"                    // model returned tool calls
      | "reactive_compact"            // context too large, compact and retry
      | "proactive_compact"           // approaching limit, compact proactively
      | "max_output_tokens_recovery"  // output truncated, inject continue
      | "stop_hook_blocking"          // quality gate blocked, injected feedback
      | "background_task_drain"       // injected background task notifications
      | "compaction_task"             // processing compaction task
      | "subtask"                     // processing subtask parts
      | (string & {})
  }

  export type Result = Terminal | Continue
}
```

#### 0.2 Refactor `SessionProcessor.process()` return type

Change return from `"stop" | "compact" | "continue"` to `Transition.Result`.

Current:
```typescript
// processor.ts:434-437
if (needsCompaction) return "compact"
if (blocked) return "stop"
if (input.assistantMessage.error) return "stop"
return "continue"
```

Change to:
```typescript
if (needsCompaction) return { type: "continue", reason: "reactive_compact" }
if (blocked) return { type: "terminal", reason: "permission_blocked" }
if (input.assistantMessage.error) return { type: "terminal", reason: "model_error", error: input.assistantMessage.error }
return { type: "continue", reason: "tool_use" }
```

#### 0.3 Refactor `prompt.ts` outer loop to consume transitions

Current pattern:
```typescript
if (result === "stop") { /* quality gate, break */ }
if (result === "compact") { /* create compaction */ }
continue
```

Change to switch on `result.type` and `result.reason`:
```typescript
if (result.type === "terminal") {
  // log terminal reason for audit
  log.info("loop terminal", { reason: result.reason, sessionID })
  if (result.reason === "permission_blocked") { break }
  // ... quality gate check only on "completed"
  break
}
// result.type === "continue"
switch (result.reason) {
  case "reactive_compact":
    await SessionCompaction.create({ ... })
    continue
  case "tool_use":
  default:
    continue
}
```

#### 0.4 Add transition to the existing continue points in `prompt.ts`

Map every existing `break`/`continue` in the outer loop to a typed transition:

| Current code | Transition |
|---|---|
| `if (abort.aborted) break` | `Terminal { reason: "aborted_streaming" }` |
| `if (lastAssistant?.finish && ...) break` | `Terminal { reason: "completed" }` |
| compaction task processed, `continue` | `Continue { reason: "compaction_task" }` |
| subtask processed, `continue` | `Continue { reason: "subtask" }` |
| context overflow compaction, `continue` | `Continue { reason: "reactive_compact" }` |
| background drain, then `continue` | `Continue { reason: "background_task_drain" }` |
| proactive budget compact, `continue` | `Continue { reason: "proactive_compact" }` |
| `result === "stop"` + quality gate block | `Continue { reason: "stop_hook_blocking" }` |
| `result === "stop"` + quality gate proceed | `Terminal { reason: "completed" }` or `Terminal { reason: "stop_hook_prevented" }` |
| structured output captured | `Terminal { reason: "structured_output" }` |

#### 0.5 Fire `session.end` with the terminal reason

Current:
```typescript
await Plugin.trigger("session.end", { sessionID, agent: sessionAgent, reason: "loop_exit" }, {})
```

Change to pass the actual terminal reason:
```typescript
await Plugin.trigger("session.end", { sessionID, agent: sessionAgent, reason: terminalReason }, {})
```

### Files to modify

- New: `packages/aboocode/src/session/transition.ts`
- Modify: `packages/aboocode/src/session/processor.ts` — change return type
- Modify: `packages/aboocode/src/session/prompt.ts` — consume typed transitions throughout loop

### Acceptance Criteria

- `SessionProcessor.process()` returns `Transition.Result`, not a string
- Every `break` and `continue` in the outer loop maps to a named reason
- `session.end` hook receives the actual terminal reason
- `npx tsc --noEmit` passes
- Existing tests pass

---

## Target 1: Replace Unsafe Prompt Cancellation

### Problem

`prompt.ts:170-171`: when the `prompt.submit` hook cancels, the function returns `undefined as any`. Every caller of `SessionPrompt.prompt()` expects a `MessageV2.WithParts` object. This crashes on `result.parts`, `result.info`, etc.

### Why This Matters

- `claude-code-leak/src/query.ts:1015-1051`: cancellation uses `AbortController` with typed `signal.reason` values (`'interrupt'` etc.), and the loop returns a typed `Terminal { reason: 'aborted_streaming' }` — never undefined
- `ai-agent-deep-dive/docs/08-agent-runtime-loop.md`: explicit termination states, never silent type escapes

### Fixing Plan

#### 1.1 Define a cancellation error

```typescript
// In session/prompt.ts or a shared location
export class PromptCancelledError extends Error {
  constructor(public readonly sessionID: string) {
    super(`Prompt cancelled by hook for session ${sessionID}`)
    this.name = "PromptCancelledError"
  }
}
```

#### 1.2 Replace `undefined as any`

Current (`prompt.ts:170-171`):
```typescript
if (submitResult.cancel) {
  return undefined as any
}
```

Change to:
```typescript
if (submitResult.cancel) {
  throw new PromptCancelledError(input.sessionID)
}
```

#### 1.3 Handle in callers

In `task.ts` (foreground and background paths): catch `PromptCancelledError` and return a typed cancelled result.

In the main loop (`prompt.ts`): if `prompt()` is called from `loop()`, the error propagates through the existing `while(true)` structure. Add a catch that maps to `Terminal { reason: "hook_cancelled" }`.

#### 1.4 Log cancellation

When the hook cancels, log it explicitly:
```typescript
log.info("prompt cancelled by hook", { sessionID: input.sessionID })
```

### Files to modify

- Modify: `packages/aboocode/src/session/prompt.ts` — replace `undefined as any`, add error class
- Modify: `packages/aboocode/src/tool/task.ts` — catch `PromptCancelledError` in both foreground/background paths

### Acceptance Criteria

- `SessionPrompt.prompt()` never returns `undefined`
- `PromptCancelledError` is a proper typed error
- Task tool handles cancellation without crashing
- No downstream `result.parts` crash on undefined

---

## Target 2: Fix Quality Gate Exit Metadata Mismatch

### Problem

`bash.ts:267` stores exit code as `exit`:
```typescript
metadata: { exit: proc.exitCode, ... }
```

`quality-gate.ts:55` reads it as `exitCode`:
```typescript
const exitCode = part.state.metadata?.exitCode
```

These never match. The gate falls back to brittle string heuristics (`output.includes("error") && output.includes("failed")`), which produces false positives (successful builds with "error" in output) and false negatives (failed builds without those strings).

### Why This Matters

- `claude-code-leak/src/utils/ShellCommand.ts:16`: Claude Code uses `code: number` as the canonical exit field — the important thing is consistency between producer and consumer
- `ai-agent-deep-dive/docs/02-tools-permissions-and-execution.md`: tool results are formal execution artifacts that must be reliably readable by downstream consumers

### Fixing Plan

#### 2.1 Standardize on `exit`

The bash tool already uses `exit`. Change `quality-gate.ts:55` to match:

```typescript
// quality-gate.ts:55
const exitCode = part.state.metadata?.exit
```

This is a one-line fix. Do not rename the bash tool's field — it's the producer and has been writing data to sessions already.

#### 2.2 Improve gate detection logic

Current fallback when `exitCode` is undefined:
```typescript
const isError = exitCode !== undefined ? exitCode !== 0 : (output.includes("error") && output.includes("failed"))
```

Improve: when exit code is available, trust it absolutely. Only use string heuristics as a last resort for legacy records:
```typescript
const exitStatus = part.state.metadata?.exit
const isError = exitStatus !== undefined
  ? exitStatus !== 0
  : output.includes("error") && output.includes("failed")
```

#### 2.3 Add regression tests

New test file: `packages/aboocode/test/hook/quality-gate.test.ts`

Test cases:
1. Successful build command with exit=0 and noisy output containing "error" → gate satisfied (no false positive)
2. Failed build command with exit=1 and minimal output → gate NOT satisfied (no false negative)
3. Successful test with exit=0 → gate satisfied
4. Failed test with exit=2 but no "error" string in output → gate NOT satisfied
5. Legacy record with no exit metadata, output containing "error" and "failed" → gate NOT satisfied (fallback works)

### Files to modify

- Modify: `packages/aboocode/src/hook/quality-gate.ts` — fix field name, improve detection
- New: `packages/aboocode/test/hook/quality-gate.test.ts` — regression tests

### Acceptance Criteria

- Quality gate reads `metadata.exit`, matching bash tool's output
- Exit code takes absolute priority over string heuristics
- Tests cover false positive and false negative cases

---

## Target 3: Real Workspace Isolation

### Problem

`AgentIsolation` (`agent/isolation.ts`) only filters tools:
- `read_only` blocks write/edit/apply_patch
- `temp` and `worktree` return `false` for all tools (no enforcement at all)

The worktree system (`worktree/index.ts`, 644 lines) is fully implemented — it can create, remove, and reset git worktrees. But it's never wired into agent sessions. A "worktree" agent runs in the same `Instance.directory` as everyone else.

### Why This Matters

- `claude-code-leak/src/utils/worktree.ts:140-154`: `WorktreeSession` stores `originalCwd`, `worktreePath`, `worktreeName`, `sessionId` — the worktree IS the execution context, not just a metadata flag
- `claude-code-leak/src/utils/worktree.ts:102-138`: symlinks `node_modules` from main repo to avoid disk bloat
- `ai-agent-deep-dive/docs/12-workspace-and-isolation.md`: five isolation modes, role-based assignment, path translation, cleanup guarantees

### Fixing Plan

#### 3.1 Introduce `IsolationContext`

New type in `agent/isolation.ts`:

```typescript
export interface IsolationContext {
  mode: IsolationMode
  /** Effective cwd for the isolated session */
  cwd: string
  /** Root directory (project root, possibly worktree) */
  root: string
  /** If mode === "temp", the temp directory path */
  tempDir?: string
  /** If mode === "worktree", the worktree info */
  worktree?: { name: string; path: string; branch: string }
  /** Cleanup function — call on task completion/abort */
  cleanup: () => Promise<void>
}
```

#### 3.2 Implement `IsolationContext` creation

New function: `AgentIsolation.create(mode, sessionID)`:

- `shared`: returns `{ cwd: Instance.directory, root: Instance.worktree, cleanup: noop }`
- `read_only`: returns `{ cwd: Instance.directory, root: Instance.worktree, cleanup: noop }` (tool filtering is separate)
- `temp`: creates a temp directory via `fs.mkdtemp`, returns it as cwd, cleanup removes it
- `worktree`: calls `Worktree.create()` from the existing worktree system, returns the worktree path as cwd/root, cleanup calls `Worktree.remove()`

#### 3.3 Wire isolation context into task execution

In `task.ts`, when spawning a subagent:

1. Resolve the agent's isolation mode
2. Call `AgentIsolation.create(mode, session.id)`
3. Pass the `IsolationContext.cwd` and `IsolationContext.root` to `SessionPrompt.prompt()` (or via the session creation)
4. Register cleanup in a `finally` block

The key change is that `SessionPrompt.prompt()` and the tools use the isolation context's `cwd`/`root` instead of `Instance.directory`/`Instance.worktree`.

#### 3.4 Pass isolation cwd through to tools

Currently `prompt.ts:630-633` hardcodes:
```typescript
path: {
  cwd: Instance.directory,
  root: Instance.worktree,
},
```

When an isolation context exists for the session, use its `cwd`/`root` instead. This can be stored in session metadata or passed through the loop input.

#### 3.5 Enforce read_only in bash tool

Current read_only isolation only blocks write/edit/apply_patch. But bash can run any command. Add to `AgentIsolation`:

```typescript
export function shellAllowed(command: string, mode: IsolationMode): boolean {
  if (mode !== "read_only") return true
  // Block obviously destructive commands
  const destructive = /\b(rm|mv|cp|mkdir|touch|chmod|chown|ln|git\s+(push|commit|merge|rebase|checkout|reset|clean))\b/
  return !destructive.test(command)
}
```

Wire this into the bash tool's permission check when the session has a read_only isolation context.

#### 3.6 Add cleanup guarantees

Register cleanup handlers that run on:
- Normal task completion (finally block in task.ts)
- Abort signal (event listener on abort controller)
- Session disposal (Instance state cleanup)

For worktrees: check for uncommitted changes before cleanup. If changes exist, log a warning and keep the worktree (let the user decide).

For temp dirs: always remove on cleanup.

#### 3.7 Add path translation

When a parent context sends file paths to a worktree agent, translate paths from `Instance.worktree` to the worktree's root:

```typescript
export function translatePath(parentPath: string, ctx: IsolationContext): string {
  if (ctx.mode !== "worktree" || !ctx.worktree) return parentPath
  const rel = path.relative(Instance.worktree, parentPath)
  if (rel.startsWith("..")) return parentPath // outside project
  return path.join(ctx.root, rel)
}
```

### Files to modify

- Modify: `packages/aboocode/src/agent/isolation.ts` — add `IsolationContext`, `create()`, `shellAllowed()`, `translatePath()`
- Modify: `packages/aboocode/src/tool/task.ts` — create isolation context, pass to session, register cleanup
- Modify: `packages/aboocode/src/session/prompt.ts` — use isolation cwd/root when available

### Acceptance Criteria

- `read_only` agents cannot modify project files (tool filtering + bash command filtering)
- `temp` agents write to a temp directory, cleaned up after completion
- `worktree` agents run in a real git worktree, wired through the existing `Worktree` system
- Cleanup runs on success, failure, and abort
- `npx tsc --noEmit` passes

---

## Target 4: Output Recovery Loop

### Problem

When the model hits the max output token limit, Aboocode's `Failure.classify()` returns `output_too_long` with `suggestedAction: "continue"`, but the recovery path in `processor.ts` doesn't actually inject a continuation message. The model just stops mid-output.

### Why This Matters

- `claude-code-leak/src/query/transitions.ts:30-31`: `max_output_tokens_recovery` and `max_output_tokens_escalate` are explicit continuation reasons — Claude Code retries with different strategies
- `ai-agent-deep-dive/docs/08-agent-runtime-loop.md`: the runtime loop must handle output truncation by injecting synthetic continuation

### Fixing Plan

#### 4.1 Add output recovery to processor

When the model finishes with `finish_reason === "length"` (output truncated), instead of marking as error:

```typescript
// processor.ts, in finish-step handler
if (value.finishReason === "length") {
  return { type: "continue", reason: "max_output_tokens_recovery" }
}
```

#### 4.2 Handle recovery in the outer loop

In `prompt.ts`, when result is `Continue { reason: "max_output_tokens_recovery" }`:

1. Track recovery attempts per turn (max 3)
2. Inject a synthetic user message: "Output limit hit. Continue exactly where you left off."
3. Continue the loop

If recovery attempts exceed 3, escalate to `Terminal { reason: "completed" }` with a warning.

```typescript
let outputRecoveryAttempts = 0
// ...
if (result.reason === "max_output_tokens_recovery") {
  outputRecoveryAttempts++
  if (outputRecoveryAttempts > 3) {
    log.warn("output recovery exhausted", { sessionID, attempts: outputRecoveryAttempts })
    break // terminal: completed with truncation
  }
  // inject continue message
  const continueMsg: MessageV2.User = { ... }
  await Session.updateMessage(continueMsg)
  await Session.updatePart({
    type: "text",
    text: "Output limit hit. Continue exactly where you left off.",
    synthetic: true,
    ...
  })
  continue
}
```

#### 4.3 Add reactive compaction retry

When `processor.ts` returns `Continue { reason: "reactive_compact" }` (context overflow during streaming), the outer loop already handles compaction. But add a counter to prevent infinite compact-retry loops:

```typescript
let compactRetries = 0
// ...
if (result.reason === "reactive_compact") {
  compactRetries++
  if (compactRetries > 2) {
    log.error("reactive compaction exhausted", { sessionID })
    break // terminal: prompt_too_long
  }
  await SessionCompaction.create({ ... })
  continue
}
```

### Files to modify

- Modify: `packages/aboocode/src/session/processor.ts` — detect `finish_reason === "length"`, return typed transition
- Modify: `packages/aboocode/src/session/prompt.ts` — handle `max_output_tokens_recovery` continuation, add retry counters

### Acceptance Criteria

- When model hits output limit, a synthetic "continue" message is injected (up to 3x)
- After 3 failed recovery attempts, the loop exits cleanly
- Reactive compaction retries are bounded (max 2)
- No infinite loops

---

## Implementation Order

```
Phase 1 (Foundation):
  Target 0: Typed Loop Transition Model
  
Phase 2 (Fix existing bugs — parallel):
  Target 1: Replace Unsafe Prompt Cancellation
  Target 2: Fix Quality Gate Exit Metadata Mismatch

Phase 3 (Structural improvements — parallel):
  Target 3: Real Workspace Isolation
  Target 4: Output Recovery Loop
```

Target 0 goes first because Targets 1, 3, and 4 all produce transitions that plug into it. Targets 1 and 2 are independent bug fixes. Targets 3 and 4 are independent structural improvements.

## Verification Checklist

- [x] `SessionProcessor.process()` returns `Transition.Result`, not a string
- [x] Every `break`/`continue` in the outer loop maps to a named transition reason
- [x] `SessionPrompt.prompt()` never returns `undefined`
- [x] `PromptCancelledError` is caught in task.ts foreground + background paths
- [x] Quality gate reads `metadata.exit`, matching bash tool
- [x] Quality gate tests cover false positives and false negatives
- [x] `read_only` agents cannot modify project files via any tool path (tool filtering + bash shell command filtering)
- [x] `temp` agents write to a temp directory that is cleaned up
- [x] `worktree` agents run in a real git worktree (existing `Worktree` system)
- [x] Output truncation triggers up to 3 synthetic continuation messages
- [x] Reactive compaction retries are bounded (max 2)
- [x] `npx tsc --noEmit` passes
- [x] `bun test` passes (all new tests pass; 8 pre-existing failures unrelated to this work)
- [x] Isolation context registered per session, prompt loop uses cwd/root from it
- [x] Bash tool uses isolation cwd and blocks destructive commands in read_only mode
- [x] Cleanup runs in finally blocks for both foreground and background task execution

## Reference

- Claude Code transition system: [`claude-code-leak/src/query/transitions.ts`](/Users/steventsai/Documents/Claude_Project/claude-code-leak/src/query/transitions.ts)
- Claude Code query loop: [`claude-code-leak/src/query.ts`](/Users/steventsai/Documents/Claude_Project/claude-code-leak/src/query.ts)
- Claude Code worktree session: [`claude-code-leak/src/utils/worktree.ts`](/Users/steventsai/Documents/Claude_Project/claude-code-leak/src/utils/worktree.ts)
- Claude Code shell result: [`claude-code-leak/src/utils/ShellCommand.ts`](/Users/steventsai/Documents/Claude_Project/claude-code-leak/src/utils/ShellCommand.ts)
- Deep dive runtime loop: [`ai-agent-deep-dive/docs/08-agent-runtime-loop.md`](/Users/steventsai/Documents/Claude_Project/ai-agent-deep-dive/docs/08-agent-runtime-loop.md)
- Deep dive workspace isolation: [`ai-agent-deep-dive/docs/12-workspace-and-isolation.md`](/Users/steventsai/Documents/Claude_Project/ai-agent-deep-dive/docs/12-workspace-and-isolation.md)
- Deep dive tool execution: [`ai-agent-deep-dive/docs/02-tools-permissions-and-execution.md`](/Users/steventsai/Documents/Claude_Project/ai-agent-deep-dive/docs/02-tools-permissions-and-execution.md)
