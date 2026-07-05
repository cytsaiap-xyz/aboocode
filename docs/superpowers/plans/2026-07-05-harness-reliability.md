# Harness Reliability (Long-Task Stability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the long-running-task stability gaps identified in the Claude Code harness comparison: bounded retries with model fallback, default step cap, compaction circuit breaker, stop-hook block cap, todo re-anchoring reminders, cache-aware microcompaction, usage-based token estimation, and wider doom-loop detection.

**Architecture:** All changes live in `packages/aboocode/src/session/` (plus one config field and one tool hook). Each mechanism is a small pure module or a bounded counter wired into the existing typed-transition loop (`session/prompt.ts` outer loop + `session/processor.ts` inner loop). No new dependencies; no schema/storage migrations (all new state is in-memory per-session).

**Tech Stack:** Bun + TypeScript, `bun:test`, existing namespaces (`SessionRetry`, `SessionCompaction`, `TokenBudget`, `Transition`, `Todo`).

## Global Constraints

- Run all commands from `packages/aboocode/` unless stated otherwise.
- Tests: `bun test test/session/<file>.test.ts` (bun:test). Typecheck: `bun run typecheck` (tsgo --noEmit).
- Code style: **no semicolons**, printWidth 120 (repo prettier config). Match surrounding idiom; namespaces over classes.
- Design ideas come from the Claude Code gap analysis. **Do not copy code or prose from `/Users/steventsai/Documents/Claude_Project/claude-code-leak` — that repo is UNLICENSED.** Write all implementations and reminder texts from scratch.
- Do not touch `opencode-reference/`.
- Commit after every task with a conventional-commit message.

## Deferred (out of scope for this plan)

- **Diminishing-returns detection**: Claude Code attaches this to its token-budget *continuation nudge* (stop nudging when 3 consecutive continuations each add <500 tokens). Aboocode has no continuation-nudge mechanism to attach it to; its unbounded-continuation analogs are covered here by the retry cap (Task 1), stop-hook block cap (Task 4), and default step cap (Task 3). Revisit if/when a task-effort budget feature is added.
- **Server-side cache-editing compaction** (`cache_edits`): Anthropic-specific API feature; requires provider-layer support in the AI SDK path. Task 6's cache-aware gating captures most of the win without it.

---

### Task 1: Cap API-error retries

The retry loop in `processor.ts:391-404` increments `attempt` forever on retryable errors. Add a hard cap so a persistently failing provider surfaces `model_error` instead of looping indefinitely.

**Files:**
- Modify: `src/session/retry.ts`
- Modify: `src/session/processor.ts:391-404`
- Test: `test/session/retry.test.ts`

**Interfaces:**
- Produces: `SessionRetry.MAX_ATTEMPTS: number` (= 10) and `SessionRetry.exhausted(attempt: number): boolean` — consumed by processor.ts here and by Task 2.

- [ ] **Step 1: Write the failing test** — append to `test/session/retry.test.ts`:

```typescript
describe("session.retry.exhausted", () => {
  test("allows attempts below the cap", () => {
    expect(SessionRetry.exhausted(1)).toBe(false)
    expect(SessionRetry.exhausted(SessionRetry.MAX_ATTEMPTS - 1)).toBe(false)
  })

  test("exhausts at the cap", () => {
    expect(SessionRetry.exhausted(SessionRetry.MAX_ATTEMPTS)).toBe(true)
    expect(SessionRetry.exhausted(SessionRetry.MAX_ATTEMPTS + 5)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/retry.test.ts`
Expected: FAIL — `exhausted is not a function`

- [ ] **Step 3: Implement** — in `src/session/retry.ts`, after `RETRY_MAX_DELAY` (line 9):

```typescript
  /** Hard cap on API-error retry attempts. Past this, the error surfaces as model_error. */
  export const MAX_ATTEMPTS = 10

  export function exhausted(attempt: number) {
    return attempt >= MAX_ATTEMPTS
  }
```

- [ ] **Step 4: Wire into processor** — in `src/session/processor.ts`, the retry branch currently reads (line 392-404):

```typescript
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined || recovery.action === "retry") {
              attempt++
```

Change the condition to give up once exhausted (the fall-through below the branch already sets `input.assistantMessage.error` and publishes `Session.Event.Error`, which yields `Transition.terminal("model_error")`):

```typescript
            const retry = SessionRetry.retryable(error)
            if ((retry !== undefined || recovery.action === "retry") && !SessionRetry.exhausted(attempt)) {
              attempt++
```

Also log the give-up right before `input.assistantMessage.error = error` (line 405):

```typescript
            if (SessionRetry.exhausted(attempt)) log.error("retry attempts exhausted", { attempt })
```

- [ ] **Step 5: Verify and commit**

Run: `bun test test/session/retry.test.ts && bun run typecheck`
Expected: PASS / no type errors

```bash
git add packages/aboocode/src/session/retry.ts packages/aboocode/src/session/processor.ts packages/aboocode/test/session/retry.test.ts
git commit -m "fix(session): cap API-error retries at SessionRetry.MAX_ATTEMPTS"
```

---

### Task 2: Fallback model on persistent overload

After 3 consecutive retryable failures, if the user configured `fallback_model`, the processor returns a new `model_fallback` continue transition; the outer loop swaps the model for subsequent steps.

**Files:**
- Modify: `src/session/retry.ts`
- Modify: `src/session/transition.ts:35-46`
- Modify: `src/session/processor.ts` (retry branch from Task 1)
- Modify: `src/session/prompt.ts:410-412, 463, 1078-1127`
- Modify: `src/config/config.ts` (next to `small_model`, line ~1072)
- Test: `test/session/retry.test.ts`

**Interfaces:**
- Consumes: `SessionRetry.exhausted` (Task 1).
- Produces: `SessionRetry.FALLBACK_AFTER_ATTEMPTS = 3`, `SessionRetry.shouldFallback(input: { attempt: number; current: string; fallback?: string }): boolean`; `Transition.Continue` reason `"model_fallback"`; config field `fallback_model?: string` (`"provider/model"` form).

- [ ] **Step 1: Write the failing test** — append to `test/session/retry.test.ts`:

```typescript
describe("session.retry.shouldFallback", () => {
  test("false when no fallback configured", () => {
    expect(SessionRetry.shouldFallback({ attempt: 5, current: "anthropic/claude-opus-4-8", fallback: undefined })).toBe(
      false,
    )
  })

  test("false before the attempt threshold", () => {
    expect(
      SessionRetry.shouldFallback({ attempt: 2, current: "anthropic/claude-opus-4-8", fallback: "anthropic/claude-sonnet-5" }),
    ).toBe(false)
  })

  test("false when already on the fallback model", () => {
    expect(
      SessionRetry.shouldFallback({ attempt: 5, current: "anthropic/claude-sonnet-5", fallback: "anthropic/claude-sonnet-5" }),
    ).toBe(false)
  })

  test("true at threshold with a different fallback configured", () => {
    expect(
      SessionRetry.shouldFallback({ attempt: 3, current: "anthropic/claude-opus-4-8", fallback: "anthropic/claude-sonnet-5" }),
    ).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/retry.test.ts`
Expected: FAIL — `shouldFallback is not a function`

- [ ] **Step 3: Implement helper** — in `src/session/retry.ts`, below `exhausted`:

```typescript
  /** After this many consecutive retryable failures, switch to config.fallback_model if set. */
  export const FALLBACK_AFTER_ATTEMPTS = 3

  export function shouldFallback(input: { attempt: number; current: string; fallback?: string }) {
    if (!input.fallback) return false
    if (input.attempt < FALLBACK_AFTER_ATTEMPTS) return false
    return input.current !== input.fallback
  }
```

- [ ] **Step 4: Add config field** — in `src/config/config.ts`, directly after the `small_model` entry (~line 1072), mirroring its zod style:

```typescript
      fallback_model: ModelId.describe(
        "Model to switch to after repeated provider overload/rate-limit failures, e.g. anthropic/claude-sonnet-5",
      ).optional(),
```

- [ ] **Step 5: Add transition reason** — in `src/session/transition.ts`, add to the `Continue` reason union (after `"overflow_compact"`, line 45):

```typescript
      | "model_fallback" // persistent provider failure, outer loop swaps to config.fallback_model
```

- [ ] **Step 6: Emit from processor** — in `src/session/processor.ts`, inside the retry branch from Task 1, insert **before** `attempt++`:

```typescript
              const { Config } = await import("../config/config")
              const config = await Config.get()
              if (
                SessionRetry.shouldFallback({
                  attempt,
                  current: `${input.model.providerID}/${input.model.id}`,
                  fallback: config.fallback_model,
                })
              ) {
                transitionLog("continue", "model_fallback")
                return Transition.cont("model_fallback")
              }
```

Note: `transitionLog` is declared later in the function (line ~445). Since it is not in scope inside the catch block, use `log.info("transition", { sessionID: input.sessionID, kind: "continue", reason: "model_fallback", attempt })` instead.

- [ ] **Step 7: Handle in the outer loop** — in `src/session/prompt.ts`:

At line 410-412, add a loop-scoped override:

```typescript
    let modelOverride: { providerID: string; modelID: string } | undefined
```

At line 463, resolve through the override:

```typescript
      const requestedModel = modelOverride ?? lastUser.model
      const model = await Provider.getModel(requestedModel.providerID, requestedModel.modelID).catch((e) => {
```

In the continue-`switch` (line 1078), add a case before `case "tool_use":`:

```typescript
        case "model_fallback": {
          const config = await Config.get()
          if (!config.fallback_model) continue
          const [providerID, ...rest] = config.fallback_model.split("/")
          modelOverride = { providerID, modelID: rest.join("/") }
          log.warn("switching to fallback model", { sessionID, model: config.fallback_model })
          continue
        }
```

`Config` is already imported in prompt.ts (verify; if not, add `import { Config } from "../config/config"`).

- [ ] **Step 8: Verify and commit**

Run: `bun test test/session/retry.test.ts && bun run typecheck`
Expected: PASS / no type errors

```bash
git add packages/aboocode/src/session/retry.ts packages/aboocode/src/session/transition.ts packages/aboocode/src/session/processor.ts packages/aboocode/src/session/prompt.ts packages/aboocode/src/config/config.ts packages/aboocode/test/session/retry.test.ts
git commit -m "feat(session): fall back to config.fallback_model on persistent provider failure"
```

---

### Task 3: Default step cap

`prompt.ts:752` sets `maxSteps = agent.steps ?? Infinity`. Introduce a large-but-finite default so runaway sessions terminate via the existing `isLastStep` wrap-up path.

**Files:**
- Create: `src/session/limits.ts`
- Modify: `src/session/prompt.ts:752`
- Test: `test/session/limits.test.ts`

**Interfaces:**
- Produces: `SessionLimits.DEFAULT_MAX_STEPS = 400` and `SessionLimits.resolveMaxSteps(steps?: number): number` — consumed by prompt.ts; Task 4 also imports `SessionLimits`.

- [ ] **Step 1: Write the failing test** — create `test/session/limits.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { SessionLimits } from "../../src/session/limits"

describe("session.limits.resolveMaxSteps", () => {
  test("uses explicit agent steps when provided", () => {
    expect(SessionLimits.resolveMaxSteps(25)).toBe(25)
  })

  test("falls back to the default cap when unset", () => {
    expect(SessionLimits.resolveMaxSteps(undefined)).toBe(SessionLimits.DEFAULT_MAX_STEPS)
  })

  test("default cap is finite and generous", () => {
    expect(Number.isFinite(SessionLimits.DEFAULT_MAX_STEPS)).toBe(true)
    expect(SessionLimits.DEFAULT_MAX_STEPS).toBeGreaterThanOrEqual(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/limits.test.ts`
Expected: FAIL — cannot resolve `../../src/session/limits`

- [ ] **Step 3: Implement** — create `src/session/limits.ts`:

```typescript
export namespace SessionLimits {
  /**
   * Default cap on loop steps per user prompt when the agent config does not
   * set `steps`. Generous enough that legitimate long tasks never hit it —
   * its only job is to bound runaway loops the doom-loop detector misses.
   */
  export const DEFAULT_MAX_STEPS = 400

  export function resolveMaxSteps(steps?: number) {
    return steps ?? DEFAULT_MAX_STEPS
  }
}
```

- [ ] **Step 4: Wire into prompt.ts** — replace line 752:

```typescript
      const maxSteps = agent.steps ?? Infinity
```

with:

```typescript
      const maxSteps = SessionLimits.resolveMaxSteps(agent.steps)
```

and add the import near the other `./` session imports at the top of `prompt.ts`:

```typescript
import { SessionLimits } from "./limits"
```

- [ ] **Step 5: Verify and commit**

Run: `bun test test/session/limits.test.ts && bun run typecheck`
Expected: PASS / no type errors

```bash
git add packages/aboocode/src/session/limits.ts packages/aboocode/src/session/prompt.ts packages/aboocode/test/session/limits.test.ts
git commit -m "feat(session): bound loop steps with DEFAULT_MAX_STEPS when agent.steps unset"
```

---

### Task 4: Auto-compaction circuit breaker + stop-hook block cap

Two unbounded failure loops get breakers: (a) auto-compaction that keeps failing (summarize → still too long → summarize …), (b) `session.stop` hook that keeps blocking (`prompt.ts:1048-1066` continues with no cap).

**Files:**
- Modify: `src/session/compaction.ts` (breaker state)
- Modify: `src/session/prompt.ts:410-412, 706-718, 865-884, 1048-1067, 1079-1094`
- Test: `test/session/compaction.test.ts`

**Interfaces:**
- Produces: `SessionCompaction.MAX_AUTO_FAILURES = 3`, `SessionCompaction.breakerTripped(sessionID): boolean`, `SessionCompaction.breakerRecord(sessionID, ok: boolean): void`, `SessionCompaction.breakerReset(sessionID): void`.
- Produces (loop-local): `stopHookBlocks` counter capped at `MAX_STOP_HOOK_BLOCKS = 3`.

- [ ] **Step 1: Write the failing test** — append to `test/session/compaction.test.ts` (follow the file's existing import style for `SessionCompaction`):

```typescript
describe("session.compaction.breaker", () => {
  test("trips after MAX_AUTO_FAILURES consecutive failures", () => {
    const id = "ses_breaker_test_1"
    SessionCompaction.breakerReset(id)
    expect(SessionCompaction.breakerTripped(id)).toBe(false)
    for (let i = 0; i < SessionCompaction.MAX_AUTO_FAILURES; i++) SessionCompaction.breakerRecord(id, false)
    expect(SessionCompaction.breakerTripped(id)).toBe(true)
  })

  test("success resets the counter", () => {
    const id = "ses_breaker_test_2"
    SessionCompaction.breakerReset(id)
    SessionCompaction.breakerRecord(id, false)
    SessionCompaction.breakerRecord(id, false)
    SessionCompaction.breakerRecord(id, true)
    SessionCompaction.breakerRecord(id, false)
    expect(SessionCompaction.breakerTripped(id)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/compaction.test.ts`
Expected: FAIL — `breakerReset is not a function`

- [ ] **Step 3: Implement breaker** — in `src/session/compaction.ts`, inside the namespace (after the `Event` block, ~line 52):

```typescript
  /**
   * Circuit breaker for automatic compaction. Repeated auto-compaction
   * failures (summarize -> still overflowing -> summarize ...) must not
   * spiral; after MAX_AUTO_FAILURES consecutive failures the session
   * surfaces prompt_too_long instead of trying again.
   */
  export const MAX_AUTO_FAILURES = 3
  const breaker = new Map<string, number>()

  export function breakerTripped(sessionID: string) {
    return (breaker.get(sessionID) ?? 0) >= MAX_AUTO_FAILURES
  }

  export function breakerRecord(sessionID: string, ok: boolean) {
    if (ok) breaker.delete(sessionID)
    else breaker.set(sessionID, (breaker.get(sessionID) ?? 0) + 1)
  }

  export function breakerReset(sessionID: string) {
    breaker.delete(sessionID)
  }
```

- [ ] **Step 4: Guard the three auto-compaction sites in prompt.ts** — each site currently calls `SessionCompaction.create({ ... auto: true })`. Wrap them:

Site A (overflow, lines 706-718) — replace the body inside the `if`:

```typescript
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        if (SessionCompaction.breakerTripped(sessionID)) {
          log.error("auto-compaction breaker tripped", { sessionID })
          terminalReason = "prompt_too_long"
          break
        }
        const ok = await SessionCompaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
          .then(() => true)
          .catch(() => false)
        SessionCompaction.breakerRecord(sessionID, ok)
        continue
      }
```

Site B (reactive budget, lines 865-874) and Site C (proactive budget, lines 875-884): apply the identical pattern — check `breakerTripped` first (`terminalReason = "prompt_too_long"; break` for reactive at Site B; for the proactive Site C just `log.warn` and fall through **without** compacting, since the session still has headroom), then `.then(() => true).catch(() => false)` + `breakerRecord`.

Site D (`case "reactive_compact":`, lines 1079-1094): before the existing `compactRetries > 2` check, add:

```typescript
          if (SessionCompaction.breakerTripped(sessionID)) {
            log.error("auto-compaction breaker tripped", { sessionID })
            terminalReason = "prompt_too_long"
            break
          }
```

and wrap its `SessionCompaction.create` call with the same `.then/.catch` + `breakerRecord`.

- [ ] **Step 5: Cap stop-hook blocks** — in `prompt.ts`, add at lines 410-412:

```typescript
    let stopHookBlocks = 0
    const MAX_STOP_HOOK_BLOCKS = 3
```

In the block branch (line 1048), change:

```typescript
            if (stopResult.action === "block" && stopResult.message) {
```

to:

```typescript
            if (stopResult.action === "block" && stopResult.message && stopHookBlocks < MAX_STOP_HOOK_BLOCKS) {
              stopHookBlocks++
```

(keep the rest of the branch as-is; when the cap is reached the code falls through to `terminalReason = result.reason; break`, ending the session normally instead of looping).

- [ ] **Step 6: Verify and commit**

Run: `bun test test/session/compaction.test.ts && bun run typecheck`
Expected: PASS / no type errors

```bash
git add packages/aboocode/src/session/compaction.ts packages/aboocode/src/session/prompt.ts packages/aboocode/test/session/compaction.test.ts
git commit -m "feat(session): circuit-break repeated auto-compaction failures and cap stop-hook blocks"
```

---

### Task 5: Todo re-anchoring reminder

After 10 loop steps without a `todowrite`, inject an ephemeral `<system-reminder>` carrying the current todo list, then wait another 10 steps before reminding again. Only fires when the agent actually has todo tools resolved.

**Files:**
- Create: `src/session/todo-reminder.ts`
- Modify: `src/tool/todo.ts` (record writes)
- Modify: `src/session/prompt.ts` (tick + inject, after `resolveTools`, ~line 810)
- Test: `test/session/todo-reminder.test.ts`

**Interfaces:**
- Consumes: `Todo.get(sessionID): Promise<Todo.Info[]>` (existing, `src/session/todo.ts:46`).
- Produces: `TodoReminder.tick(sessionID)`, `TodoReminder.recordWrite(sessionID)`, `TodoReminder.build(sessionID): Promise<string | undefined>`, `TodoReminder.reset(sessionID)`, constants `TURNS_SINCE_WRITE = 10`, `TURNS_BETWEEN_REMINDERS = 10`.

- [ ] **Step 1: Write the failing test** — create `test/session/todo-reminder.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { TodoReminder } from "../../src/session/todo-reminder"

describe("session.todo-reminder", () => {
  test("not due before TURNS_SINCE_WRITE ticks", () => {
    const id = "ses_todo_rem_1"
    TodoReminder.reset(id)
    for (let i = 0; i < TodoReminder.TURNS_SINCE_WRITE - 1; i++) TodoReminder.tick(id)
    expect(TodoReminder.due(id)).toBe(false)
  })

  test("due after TURNS_SINCE_WRITE ticks without a write", () => {
    const id = "ses_todo_rem_2"
    TodoReminder.reset(id)
    for (let i = 0; i < TodoReminder.TURNS_SINCE_WRITE; i++) TodoReminder.tick(id)
    expect(TodoReminder.due(id)).toBe(true)
  })

  test("recordWrite resets the counter", () => {
    const id = "ses_todo_rem_3"
    TodoReminder.reset(id)
    for (let i = 0; i < TodoReminder.TURNS_SINCE_WRITE; i++) TodoReminder.tick(id)
    TodoReminder.recordWrite(id)
    expect(TodoReminder.due(id)).toBe(false)
  })

  test("markReminded suppresses for TURNS_BETWEEN_REMINDERS", () => {
    const id = "ses_todo_rem_4"
    TodoReminder.reset(id)
    for (let i = 0; i < TodoReminder.TURNS_SINCE_WRITE; i++) TodoReminder.tick(id)
    TodoReminder.markReminded(id)
    expect(TodoReminder.due(id)).toBe(false)
    for (let i = 0; i < TodoReminder.TURNS_BETWEEN_REMINDERS; i++) TodoReminder.tick(id)
    expect(TodoReminder.due(id)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/todo-reminder.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement** — create `src/session/todo-reminder.ts`:

```typescript
import { Todo } from "./todo"

/**
 * Long tasks drift: the model stops maintaining its todo list and loses the
 * thread. Every loop step ticks a per-session counter; once the model has
 * gone TURNS_SINCE_WRITE steps without a todowrite (and at least
 * TURNS_BETWEEN_REMINDERS since the last nudge), build() returns an
 * ephemeral <system-reminder> carrying the current list.
 */
export namespace TodoReminder {
  export const TURNS_SINCE_WRITE = 10
  export const TURNS_BETWEEN_REMINDERS = 10

  interface State {
    sinceWrite: number
    sinceReminder: number
  }
  const sessions = new Map<string, State>()

  function get(sessionID: string): State {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const created = { sinceWrite: 0, sinceReminder: TURNS_BETWEEN_REMINDERS }
    sessions.set(sessionID, created)
    return created
  }

  export function tick(sessionID: string) {
    const state = get(sessionID)
    state.sinceWrite++
    state.sinceReminder++
  }

  export function recordWrite(sessionID: string) {
    const state = get(sessionID)
    state.sinceWrite = 0
  }

  export function markReminded(sessionID: string) {
    const state = get(sessionID)
    state.sinceReminder = 0
  }

  export function due(sessionID: string) {
    const state = sessions.get(sessionID)
    if (!state) return false
    return state.sinceWrite >= TURNS_SINCE_WRITE && state.sinceReminder >= TURNS_BETWEEN_REMINDERS
  }

  export function reset(sessionID: string) {
    sessions.delete(sessionID)
  }

  /** Returns reminder text when due and the session has open todos, else undefined. */
  export async function build(sessionID: string): Promise<string | undefined> {
    if (!due(sessionID)) return undefined
    const todos = await Todo.get(sessionID)
    const open = todos.filter((t) => t.status !== "completed")
    if (open.length === 0) return undefined
    markReminded(sessionID)
    return [
      "<system-reminder>",
      "It has been a while since the todo list was updated. Review it, mark finished items completed, and make sure your current work still matches it. Do not mention this reminder to the user.",
      "",
      "Current todo list:",
      JSON.stringify(todos, null, 2),
      "</system-reminder>",
    ].join("\n")
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/session/todo-reminder.test.ts`
Expected: PASS

- [ ] **Step 5: Record writes** — in `src/tool/todo.ts`, inside `TodoWriteTool.execute` right after `await Todo.update({ ... })`:

```typescript
    const { TodoReminder } = await import("../session/todo-reminder")
    TodoReminder.recordWrite(ctx.sessionID)
```

- [ ] **Step 6: Tick and inject in the loop** — in `src/session/prompt.ts`, after the `resolveTools` call completes (~line 810, before the StructuredOutput injection):

```typescript
      // Re-anchor long tasks on their todo list (ephemeral, not persisted)
      if (tools["todowrite"]) {
        const { TodoReminder } = await import("./todo-reminder")
        TodoReminder.tick(sessionID)
        const reminder = await TodoReminder.build(sessionID)
        if (reminder) {
          const reminderTarget = msgs.findLast((m) => m.info.role === "user")
          reminderTarget?.parts.push({
            id: Identifier.ascending("part"),
            messageID: reminderTarget.info.id,
            sessionID,
            type: "text",
            text: reminder,
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }
      }
```

Note: parts are mutated in-memory only (same ephemeral pattern as the queued-message wrap at lines 829-846) — the reminder is not persisted to storage.

- [ ] **Step 7: Verify and commit**

Run: `bun test test/session/todo-reminder.test.ts && bun run typecheck`
Expected: PASS / no type errors

```bash
git add packages/aboocode/src/session/todo-reminder.ts packages/aboocode/src/tool/todo.ts packages/aboocode/src/session/prompt.ts packages/aboocode/test/session/todo-reminder.test.ts
git commit -m "feat(session): re-anchor long tasks with periodic todo-list reminders"
```

---

### Task 6: Cache-aware microcompaction

`microCompact` currently rewrites old tool results **every step**, which breaks the provider prompt-cache prefix on every mutation. Gate it: only clear old tool results when (a) the provider cache is already cold (>= 5 min since the last assistant completion — Anthropic's ephemeral cache TTL), or (b) context pressure makes it necessary anyway.

**Files:**
- Modify: `src/session/compaction.ts` (pure predicate)
- Modify: `src/session/prompt.ts:702-703`
- Test: `test/session/compaction.test.ts`

**Interfaces:**
- Produces: `SessionCompaction.CACHE_TTL_MS = 300_000`, `SessionCompaction.MICRO_COMPACT_PRESSURE = 0.75`, `SessionCompaction.shouldMicroCompact(input: { lastCompleted?: number; now: number; ratio: number }): boolean`, `SessionCompaction.usageRatio(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }): number`.

- [ ] **Step 1: Write the failing test** — append to `test/session/compaction.test.ts`:

```typescript
describe("session.compaction.shouldMicroCompact", () => {
  const now = 1_750_000_000_000

  test("skips when cache is warm and pressure is low", () => {
    expect(
      SessionCompaction.shouldMicroCompact({ lastCompleted: now - 60_000, now, ratio: 0.3 }),
    ).toBe(false)
  })

  test("runs when the cache has gone cold", () => {
    expect(
      SessionCompaction.shouldMicroCompact({ lastCompleted: now - SessionCompaction.CACHE_TTL_MS, now, ratio: 0.3 }),
    ).toBe(true)
  })

  test("runs under context pressure even with a warm cache", () => {
    expect(
      SessionCompaction.shouldMicroCompact({ lastCompleted: now - 10_000, now, ratio: SessionCompaction.MICRO_COMPACT_PRESSURE }),
    ).toBe(true)
  })

  test("skips on first step (no prior assistant message, low pressure)", () => {
    expect(SessionCompaction.shouldMicroCompact({ lastCompleted: undefined, now, ratio: 0.1 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/compaction.test.ts`
Expected: FAIL — `shouldMicroCompact is not a function`

- [ ] **Step 3: Implement predicate** — in `src/session/compaction.ts`, above `microCompact`:

```typescript
  /**
   * Provider prompt caches expire after ~5 minutes. Rewriting old tool
   * results while the cache is warm forces a full uncached re-read of the
   * prefix, so micro-compaction only runs when the cache is already cold
   * or when context pressure makes shrinking necessary regardless.
   */
  export const CACHE_TTL_MS = 5 * 60 * 1000
  export const MICRO_COMPACT_PRESSURE = 0.75

  export function shouldMicroCompact(input: { lastCompleted?: number; now: number; ratio: number }) {
    if (input.ratio >= MICRO_COMPACT_PRESSURE) return true
    if (input.lastCompleted === undefined) return false
    return input.now - input.lastCompleted >= CACHE_TTL_MS
  }

  export function usageRatio(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const context = input.model.limit.context
    if (context === 0) return 0
    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
    const usable = input.model.limit.input
      ? input.model.limit.input
      : context - ProviderTransform.maxOutputTokens(input.model)
    if (usable <= 0) return 0
    return count / usable
  }
```

(`ProviderTransform` is already imported by `isOverflow` in this file.)

- [ ] **Step 4: Gate the call site** — in `src/session/prompt.ts`, replace lines 702-703:

```typescript
      // Phase 0: Micro-compact old tool results before building model messages
      await SessionCompaction.microCompact({ sessionID })
```

with:

```typescript
      // Phase 0: Micro-compact old tool results — but only when the provider
      // prompt cache is already cold or context pressure demands it, so we
      // don't invalidate a warm cache prefix on every step.
      if (
        SessionCompaction.shouldMicroCompact({
          lastCompleted: lastFinished?.time.completed,
          now: Date.now(),
          ratio: lastFinished?.tokens ? SessionCompaction.usageRatio({ tokens: lastFinished.tokens, model }) : 0,
        })
      ) {
        await SessionCompaction.microCompact({ sessionID })
      }
```

(If `lastFinished`'s type does not expose `time.completed`, use `(lastFinished as MessageV2.Assistant | undefined)?.time.completed` — assistant messages set `time.completed` in `processor.ts:443`.)

- [ ] **Step 5: Verify and commit**

Run: `bun test test/session/compaction.test.ts && bun run typecheck`
Expected: PASS / no type errors

```bash
git add packages/aboocode/src/session/compaction.ts packages/aboocode/src/session/prompt.ts packages/aboocode/test/session/compaction.test.ts
git commit -m "perf(session): gate micro-compaction on cache coldness or context pressure"
```

---

### Task 7: Usage-based token estimation

`TokenBudget.estimate` is a 4-chars/token heuristic over the whole conversation — inaccurate for CJK and code. The API already reports exact usage on every assistant message (`lastFinished.tokens`). Use that as the baseline and only char-estimate messages newer than the last assistant turn.

**Files:**
- Modify: `src/session/token-budget.ts`
- Modify: `src/session/prompt.ts:850-855`
- Test: `test/session/token-budget.test.ts` (new file)

**Interfaces:**
- Produces: `TokenBudget.fromUsage(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }): number`.

- [ ] **Step 1: Write the failing test** — create `test/session/token-budget.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { TokenBudget } from "../../src/session/token-budget"

describe("session.token-budget.fromUsage", () => {
  test("sums input, output and cache tokens", () => {
    expect(
      TokenBudget.fromUsage({ input: 1000, output: 200, reasoning: 50, cache: { read: 30_000, write: 500 } }),
    ).toBe(31_700)
  })

  test("zero usage yields zero", () => {
    expect(TokenBudget.fromUsage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/token-budget.test.ts`
Expected: FAIL — `fromUsage is not a function`

- [ ] **Step 3: Implement** — in `src/session/token-budget.ts`, after `estimate`:

```typescript
  /**
   * Exact context size as reported by the provider on the last assistant
   * turn. Prefer this over char-based estimation whenever available —
   * reasoning tokens are excluded because they do not persist in context.
   */
  export function fromUsage(tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }): number {
    return tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
  }
```

- [ ] **Step 4: Wire into prompt.ts** — replace lines 852-854:

```typescript
      const budget = await TokenBudget.fromModel(model)
      const modelMessages = MessageV2.toModelMessages(msgs, model)
      budget.currentEstimate = TokenBudget.estimate(modelMessages)
```

with:

```typescript
      const budget = await TokenBudget.fromModel(model)
      const modelMessages = MessageV2.toModelMessages(msgs, model)
      if (lastFinished?.tokens && lastFinished.summary !== true) {
        // Exact usage from the last assistant turn + estimate of everything newer
        const newer = msgs.filter((m) => m.info.id > lastFinished.id)
        budget.currentEstimate =
          TokenBudget.fromUsage(lastFinished.tokens) + TokenBudget.estimate(MessageV2.toModelMessages(newer, model))
      } else {
        budget.currentEstimate = TokenBudget.estimate(modelMessages)
      }
```

Notes: message IDs are lexicographically ascending (`Identifier.ascending`), so string comparison orders correctly. After a summarization (`lastFinished.summary === true`) the pre-compact usage no longer reflects the trimmed context, hence the fallback to pure estimation for that turn.

- [ ] **Step 5: Verify and commit**

Run: `bun test test/session/token-budget.test.ts && bun run typecheck`
Expected: PASS / no type errors

```bash
git add packages/aboocode/src/session/token-budget.ts packages/aboocode/src/session/prompt.ts packages/aboocode/test/session/token-budget.test.ts
git commit -m "feat(session): base token budget on exact API usage instead of char heuristic"
```

---

### Task 8: Widen doom-loop detection

`processor.ts:154-179` only catches 3 **consecutive** byte-identical tool calls. Alternating loops (A,B,A,B,A,B) slip through. Extract a pure detector that counts identical calls within a sliding window.

**Files:**
- Create: `src/session/loop-detect.ts`
- Modify: `src/session/processor.ts:154-179`
- Test: `test/session/loop-detect.test.ts`

**Interfaces:**
- Produces: `LoopDetect.WINDOW = 8`, `LoopDetect.THRESHOLD = 3`, `LoopDetect.repeated(calls: { tool: string; input: unknown }[]): { tool: string; input: unknown } | undefined`.

- [ ] **Step 1: Write the failing test** — create `test/session/loop-detect.test.ts`:

```typescript
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
    const calls = [read("/a"), read("/a")]
    for (let i = 0; i < LoopDetect.WINDOW; i++) calls.push(bash(`step ${i}`))
    calls.push(read("/a"))
    expect(LoopDetect.repeated(calls)).toBeUndefined()
  })

  test("distinct inputs never trigger", () => {
    const calls = [read("/a"), read("/b"), read("/c"), read("/d")]
    expect(LoopDetect.repeated(calls)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/loop-detect.test.ts`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement** — create `src/session/loop-detect.ts`:

```typescript
/**
 * Doom-loop detection over a sliding window of tool calls. Consecutive-only
 * checks miss alternating loops (read A, run B, read A, ...), so any call
 * repeated THRESHOLD times within the last WINDOW calls counts as a loop.
 */
export namespace LoopDetect {
  export const WINDOW = 8
  export const THRESHOLD = 3

  export function repeated(calls: { tool: string; input: unknown }[]): { tool: string; input: unknown } | undefined {
    const recent = calls.slice(-WINDOW)
    const counts = new Map<string, { call: { tool: string; input: unknown }; count: number }>()
    for (const call of recent) {
      const key = `${call.tool} ${JSON.stringify(call.input)}`
      const entry = counts.get(key) ?? { call, count: 0 }
      entry.count++
      counts.set(key, entry)
      if (entry.count >= THRESHOLD) return entry.call
    }
    return undefined
  }
}
```

- [ ] **Step 4: Wire into processor** — in `src/session/processor.ts`, replace the `lastThree` block (lines 154-179) with:

```typescript
                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const { LoopDetect } = await import("./loop-detect")
                    const calls = parts.flatMap((p) =>
                      p.type === "tool" && p.state.status !== "pending" ? [{ tool: p.tool, input: p.state.input }] : [],
                    )
                    calls.push({ tool: value.toolName, input: value.input })
                    const repeat = LoopDetect.repeated(calls)
                    if (repeat && repeat.tool === value.toolName) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
```

Delete the now-unused `DOOM_LOOP_THRESHOLD` constant if nothing else references it (grep first: `grep -rn DOOM_LOOP_THRESHOLD src/`).

- [ ] **Step 5: Verify and commit**

Run: `bun test test/session/loop-detect.test.ts && bun run typecheck`
Expected: PASS / no type errors

```bash
git add packages/aboocode/src/session/loop-detect.ts packages/aboocode/src/session/processor.ts packages/aboocode/test/session/loop-detect.test.ts
git commit -m "feat(session): detect alternating doom loops with sliding-window repeat check"
```

---

### Task 9: Full regression pass

**Files:** none new.

- [ ] **Step 1: Run the whole session suite**

Run: `bun test test/session/`
Expected: all PASS (pre-existing failures, if any, must match `git stash && bun test test/session/` baseline — verify before blaming your changes)

- [ ] **Step 2: Typecheck the package**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 3: Smoke-test the loop end-to-end**

Run from repo root: `bun run dev -- run "read package.json and summarize the scripts section"`
Expected: session completes normally, no compaction/breaker log errors in output

- [ ] **Step 4: Commit any stragglers**

```bash
git status --short
git add -A packages/aboocode && git commit -m "chore(session): harness reliability follow-ups" || echo "nothing to commit"
```
