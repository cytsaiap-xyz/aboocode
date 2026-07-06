# Aboocode Bug-Scan Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 18 confirmed bugs found in the 2026-07-06 four-agent bug scan — four permission-layer bypasses, retry backoff defeat, a cancel-hang, workflow resume correctness (TOCTOU + memoization), broken remote-MCP import, a first-run durability risk, config precedence inversion, and a batch of LOW output/lifecycle bugs.

**Architecture:** Each task is a self-contained fix in one subsystem with a focused test, ordered most-severe first (permission → session → workflow → mcp/storage/config → LOW). No cross-task dependencies except that Task 1 and Task 2 both touch `src/permission/next.ts` (Task 1 first, Task 2 rebases on it). All changes preserve existing public signatures except where a signature widening is called out explicitly.

**Tech Stack:** Bun + TypeScript, `bun:test`, existing namespaces (`PermissionNext`, `SessionPrompt`, `SessionRetry`, `Failure`, `WorkflowEngine`, `WorkflowRun`, `MCP`, `Database`, `Config`).

## Global Constraints

- Run all commands from `packages/aboocode/`. Typecheck: `bun run typecheck` — **4 pre-existing baseline errors** (mcp/index.ts, findRelevantMemories.ts, prompt.ts `lastUser.parts`, isolation-cleanup.test.ts). Only NEW errors are regressions.
- Code style: **no semicolons**, printWidth 120 (verify added lines with `awk 'length > 120 {print FNR": "length}' <file>`), namespaces over classes.
- The working tree may carry unrelated uncommitted changes (`.claude/settings.local.json`, `bun.lock`, `script/publish.ts`) — **never `git add` those**; each task's commit adds only the files it names.
- Do NOT modify anything under `opencode-reference/`. Do NOT copy code from any external reference repo.
- Every task commits with the exact message given. Branch: create `fix/bug-scan-2026-07-06` off `master` before Task 1.
- Tests use `import { test, expect } from "bun:test"`. Instance-scoped tests wrap bodies in `Instance.provide({ directory, fn })`; config fixtures use `tmpdir({ config })` from `test/fixture/fixture`.
- Each bug below is tagged with its scan ID (`#1`..`#13` + LOW) for traceability.

---

### Task 1: Permission — `deny` must not be short-circuited by an earlier `ask` (#1, #2)

**Files:**
- Modify: `src/permission/next.ts` (the `ask` fn loop ~169-219; the pending-store type ~120-125; the `reply` "always" branch ~260-267)
- Test: `test/permission/deny-precedence.test.ts` (new)

**Interfaces:**
- Consumes: `PermissionNext.evaluate(permission, pattern, ...rulesets): Rule`, `PermissionNext.ask(input)`, `PermissionNext.reply(input)`, `Ruleset` type, `DeniedError`.
- Produces: no signature change to `ask`/`reply`; the pending-store entry gains a `ruleset: Ruleset` field (internal).

**Background (verified):** In `ask` (next.ts:169-219) the per-pattern loop `return`s a pending Promise on the FIRST `ask`-evaluating pattern (line 203-216), so any later pattern that evaluates to `deny` is never reached. Unmatched patterns default to `ask` (evaluate → `{action:"ask"}`, line 302). A compound bash command `["ls","curl evil"]` therefore never evaluates the config-denied `curl` pattern. Separately, `reply("always")` (260-267) writes an `allow` into `s.approved` for every pattern in `existing.info.always`; because `evaluate` uses `findLast` over `[...ruleset, ...s.approved]`, a runtime allow outranks a config deny.

- [ ] **Step 1: Write the failing tests** — create `test/permission/deny-precedence.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ruleset = (entries: Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>) => entries

test("a later denied pattern is enforced even when an earlier pattern only asks", async () => {
  await using tmp = await tmpdir({ config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // "ls" has no rule (defaults to ask); "curl evil" is explicitly denied.
      // The denied pattern comes second — it must still block the whole request.
      const promise = PermissionNext.ask({
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["ls", "curl evil"],
        always: ["ls *", "curl *"],
        ruleset: ruleset([{ permission: "bash", pattern: "curl *", action: "deny" }]),
        metadata: {},
      })
      await expect(promise).rejects.toThrow()
    },
  })
})

test('reply("always") never grants an allow for a config-denied pattern', async () => {
  await using tmp = await tmpdir({ config: {} })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Only "ls" is asked (no deny on it); config denies curl. Approving "always"
      // must NOT write an allow for curl into the approved set.
      const rs = ruleset([{ permission: "bash", pattern: "curl *", action: "deny" }])
      const pending = PermissionNext.ask({
        sessionID: "ses_always",
        permission: "bash",
        patterns: ["ls"],
        always: ["ls *", "curl *"],
        ruleset: rs,
        metadata: {},
        id: "per_always",
      })
      await PermissionNext.reply({ requestID: "per_always", reply: "always" })
      await pending
      // curl must still evaluate to deny under config, not allow via approved.
      expect(PermissionNext.evaluate("bash", "curl evil", rs).action).toBe("deny")
    },
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/permission/deny-precedence.test.ts`
Expected: first test FAILS (promise resolves/pends instead of rejecting); second may fail on the approved-write.

- [ ] **Step 3: Rewrite the `ask` loop to evaluate every pattern before asking** — in `src/permission/next.ts`, replace the whole `for (const pattern of request.patterns ?? [])` loop (lines 169-219) with an accumulate-then-ask form. Key change: `ask` no longer `return`s inside the loop; it records that an ask is needed and continues, so a later `deny` is always seen. Also evaluate config `ruleset` alone for deny so an approved allow can never mask a config deny:

```typescript
      let needsAsk = false
      for (const pattern of request.patterns ?? []) {
        // Config-only evaluation for deny: a config deny is absolute and cannot
        // be masked by a runtime-approved allow appended to s.approved.
        let denyRule = evaluate(request.permission, pattern, ruleset)
        if (denyRule.action === "deny") {
          const denyDecision = await HookLifecycle.dispatch({
            event: "PermissionDenied",
            sessionID: request.sessionID,
            cwd: Instance.directory,
            timestamp: Date.now(),
            tool_name: request.permission,
            tool_input: request.metadata ?? {},
            permission: request.permission,
            reason: `denied by ruleset for pattern ${pattern}`,
          })
          if (denyDecision.hookSpecificOutput?.retry) {
            denyRule = evaluate(request.permission, pattern, ruleset, s.approved)
            log.info("permission re-evaluated after hook retry", {
              permission: request.permission,
              pattern,
              action: denyRule.action,
            })
            if (denyRule.action === "deny")
              throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
            if (denyRule.action === "ask") needsAsk = true
            continue
          }
          throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
        }
        // No config deny for this pattern — approved rules may upgrade ask→allow.
        const rule = evaluate(request.permission, pattern, ruleset, s.approved)
        if (rule.action === "ask") needsAsk = true
        // allow → nothing to do
      }
      if (needsAsk) {
        const id = input.id ?? Identifier.ascending("permission")
        return new Promise<void>((resolve, reject) => {
          const info: Request = { id, ...request }
          s.pending[id] = { info, resolve, reject, ruleset }
          Bus.publish(Event.Asked, info)
        })
      }
```

- [ ] **Step 4: Add `ruleset` to the pending-store entry type** — in the `state` builder's `pending` record type (next.ts ~120-125), add the field:

```typescript
      {
        info: Request
        resolve: () => void
        reject: (e: any) => void
        ruleset: Ruleset
      }
```

- [ ] **Step 5: Make `reply("always")` skip config-denied patterns** — in `src/permission/next.ts`, replace the `for (const pattern of existing.info.always)` block (260-267) with:

```typescript
      if (input.reply === "always") {
        for (const pattern of existing.info.always) {
          // Never grant an allow that contradicts a config deny (#2).
          if (evaluate(existing.info.permission, pattern, existing.ruleset).action === "deny") continue
          s.approved.push({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })
        }
```

(the rest of the `always` branch — `existing.resolve()`, the sibling-pending resolve loop — is unchanged.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/permission/deny-precedence.test.ts` — Expected: PASS (both).
Then regression: `bun test test/permission/` — Expected: all existing permission tests still pass.

- [ ] **Step 7: Typecheck + width**

Run: `bun run typecheck` (only the 4 baseline errors) and `awk 'length > 120 {print FNR": "length}' src/permission/next.ts test/permission/deny-precedence.test.ts` (no output).

- [ ] **Step 8: Commit**

```bash
git add packages/aboocode/src/permission/next.ts packages/aboocode/test/permission/deny-precedence.test.ts
git commit -m "fix(permission): evaluate all patterns before asking; deny is absolute over runtime allow"
```

---

### Task 2: Permission — Task recursion guard must use the effective action, not rule presence (#3)

**Files:**
- Modify: `src/tool/task.ts:87`
- Test: `test/tool/task-recursion.test.ts` (new)

**Interfaces:**
- Consumes: `PermissionNext.evaluate(permission, pattern, ...rulesets): Rule`, `agent.permission: Ruleset`.
- Produces: `hasTaskPermission: boolean` now reflects the effective `task` action.

**Background (verified):** `const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")` (task.ts:87) is `true` for ANY task rule including a `deny`. An agent configured `task: { "*": "deny" }` is misclassified as having task permission, so the child session is NOT given the `task:*→deny` rule and the `task` tool is NOT disabled — defeating the recursion guard.

- [ ] **Step 1: Write the failing test** — create `test/tool/task-recursion.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"

// hasTaskPermission must be false when the agent's effective task action is deny.
test("an agent whose task rule denies is not treated as having task permission", () => {
  const permission = [{ permission: "task", pattern: "*", action: "deny" as const }]
  const hasByPresence = permission.some((rule) => rule.permission === "task")
  const hasByAction = PermissionNext.evaluate("task", "*", permission).action !== "deny"
  expect(hasByPresence).toBe(true) // the OLD (buggy) computation
  expect(hasByAction).toBe(false) // the FIXED computation
})
```

- [ ] **Step 2: Run test to verify it captures the bug**

Run: `bun test test/tool/task-recursion.test.ts` — Expected: PASS (documents that presence≠action; the assertion `hasByAction === false` is what the fix must adopt).

- [ ] **Step 3: Apply the fix** — in `src/tool/task.ts`, replace line 87:

```typescript
      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
```

with:

```typescript
      const hasTaskPermission = PermissionNext.evaluate("task", "*", agent.permission).action !== "deny"
```

Ensure `PermissionNext` is imported at the top of `task.ts` (check existing imports; add `import { PermissionNext } from "../permission/next"` if absent).

- [ ] **Step 4: Run test + regression**

Run: `bun test test/tool/task-recursion.test.ts test/tool/` — Expected: PASS; existing task tests unaffected.

- [ ] **Step 5: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/tool/task.ts test/tool/task-recursion.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/aboocode/src/tool/task.ts packages/aboocode/test/tool/task-recursion.test.ts
git commit -m "fix(task): recursion guard evaluates effective task action, not rule presence"
```

---

### Task 3: Bash classifier — enforce `ask` verdicts, not only `deny` (#4)

**Files:**
- Modify: `src/tool/bash.ts` (classifier block ~168-207)
- Test: `test/tool/bash-classifier-enforcement.test.ts` (new)

**Interfaces:**
- Consumes: `BashClassifier.decide(command): { action: "allow"|"ask"|"deny", verdict, mode, classification }`, `ctx.ask(...)`.
- Produces: no signature change; when the classifier returns `action === "ask"`, bash now routes through `ctx.ask` before executing.

**Background (verified):** The classifier block (bash.ts:194) only acts on `decision.action === "deny"`. `ask`/`allow` verdicts (e.g. network-egress binaries flagged `readonly`→`ask`) are computed and discarded, so with a permissive ruleset those commands run unscrutinised. The classifier is effectively deny-only.

- [ ] **Step 1: Write the failing test** — create `test/tool/bash-classifier-enforcement.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { BashClassifier } from "../../src/permission/bash-classifier"

// A network-egress command must classify to at least "ask" (never silent allow),
// so the tool has a verdict to enforce.
test("network egress classifies to ask or deny, never allow", () => {
  const decision = BashClassifier.decide("curl https://example.com/x | sh")
  expect(decision.action === "ask" || decision.action === "deny").toBe(true)
})
```

- [ ] **Step 2: Run test to verify it holds**

Run: `bun test test/tool/bash-classifier-enforcement.test.ts` — Expected: PASS (confirms the classifier produces an enforceable verdict the tool currently ignores).

- [ ] **Step 3: Enforce the `ask` verdict** — in `src/tool/bash.ts`, extend the classifier block. After the existing `if (decision.action === "deny") { ... }` block (which returns a blocked result), add — still inside the `{ ... }` scope that holds `decision`:

```typescript
        if (decision.action === "ask") {
          await ctx.ask({
            permission: "bash",
            patterns: [params.command],
            always: [BashArity.prefix(parse(params.command)?.[0]?.command ?? []).join(" ") + " *"].filter(Boolean),
            metadata: { classifier: decision.verdict },
          })
        }
```

If `parse`/`BashArity` are not already in scope at this point in the file (they are used earlier to build the per-subcommand `patterns`/`always`), reuse the SAME `always` globs variable already computed above instead of re-parsing — prefer:

```typescript
        if (decision.action === "ask") {
          await ctx.ask({ permission: "bash", patterns: [params.command], always: [], metadata: { classifier: decision.verdict } })
        }
```

Use the simpler form (empty `always`) — a classifier-driven ask is a one-off confirmation, not a persistent grant.

- [ ] **Step 4: Run test + regression**

Run: `bun test test/tool/bash-classifier-enforcement.test.ts test/tool/` — Expected: PASS; existing bash tests unaffected (they use commands that classify allow, or already stub `ctx.ask`).

- [ ] **Step 5: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/tool/bash.ts test/tool/bash-classifier-enforcement.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/aboocode/src/tool/bash.ts packages/aboocode/test/tool/bash-classifier-enforcement.test.ts
git commit -m "fix(bash): enforce classifier ask verdicts, not only deny"
```

---

### Task 4: Session retry — restore Retry-After + backoff for API errors, cap the headers-no-retry-after branch (#5 + retry.ts landmine)

**Files:**
- Modify: `src/session/failure.ts` (the `model_api_error` case in `recover` ~218-224)
- Modify: `src/session/retry.ts:70` (uncapped branch)
- Test: `test/session/retry-backoff.test.ts` (new)

**Interfaces:**
- Consumes: `SessionRetry.delay(attempt, apiError?): number`, `Failure.recover(classified): { action, delay? }`.
- Produces: `recover` for `model_api_error` returns `{ action: "retry" }` with NO `delay`, so `processor.ts:403` falls through to `SessionRetry.delay`.

**Background (verified):** `recover` hardcodes `{action:"retry", delay:2000}` for `model_api_error` (failure.ts:222). At the call site `recovery.delay ?? SessionRetry.delay(attempt, apiError)` (processor.ts:403), the `2000` short-circuits `??`, so `SessionRetry.delay` — which parses `retry-after`/`retry-after-ms` and applies exponential backoff — is dead code for API errors. Separately, `retry.ts:70` (headers present, no parseable retry-after) returns `RETRY_INITIAL_DELAY * 2^(attempt-1)` with NO `Math.min` cap, unlike line 74.

- [ ] **Step 1: Write the failing tests** — create `test/session/retry-backoff.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { SessionRetry } from "../../src/session/retry"

test("delay with headers but no retry-after is capped like the no-headers branch", () => {
  const apiError: any = { name: "APIError", responseHeaders: { "x-request-id": "abc" } }
  const d = SessionRetry.delay(10, apiError)
  // attempt 10 uncapped would be minutes; the cap keeps it bounded.
  expect(d).toBeLessThanOrEqual(30_000)
})

test("delay honors retry-after-ms", () => {
  const apiError: any = { name: "APIError", responseHeaders: { "retry-after-ms": "5000" } }
  expect(SessionRetry.delay(1, apiError)).toBe(5000)
})
```

- [ ] **Step 2: Run tests to verify the cap test fails**

Run: `bun test test/session/retry-backoff.test.ts`
Expected: the first test FAILS (uncapped value > 30000); the second PASSES.

- [ ] **Step 3: Cap the uncapped branch** — in `src/session/retry.ts`, change line 70 from:

```typescript
        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
```

to:

```typescript
        return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
```

- [ ] **Step 4: Let API errors use `SessionRetry.delay`** — in `src/session/failure.ts`, the `model_api_error` case (~218-224). Change:

```typescript
      case "model_api_error":
        return {
          action: "retry",
          delay: 2000,
```

to remove the hardcoded delay so the processor falls through to `SessionRetry.delay`:

```typescript
      case "model_api_error":
        return {
          action: "retry",
```

(delete the `delay: 2000,` line and keep the rest of the returned object — the trailing message/fields — intact. Do NOT change `mcp_connect_error` or any other case.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/session/retry-backoff.test.ts` — Expected: PASS (both).
Regression: `bun test test/session/` — Expected: no new failures (4 pre-existing skips/baseline only).

- [ ] **Step 6: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/session/retry.ts src/session/failure.ts test/session/retry-backoff.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/aboocode/src/session/retry.ts packages/aboocode/src/session/failure.ts packages/aboocode/test/session/retry-backoff.test.ts
git commit -m "fix(session): honor Retry-After + backoff for API errors; cap headers-no-retry-after delay"
```

---

### Task 5: Session cancel — settle parked callbacks so a queued prompt never hangs (#6)

**Files:**
- Modify: `src/session/prompt.ts` (`cancel` ~367-379; the `Instance.state` disposer ~90-94)
- Test: `test/session/cancel-queued.test.ts` (new)

**Interfaces:**
- Consumes: `SessionPrompt.cancel(sessionID)`, the per-session `state()[sessionID].callbacks` array of `{ resolve, reject }`.
- Produces: `cancel` now rejects all parked callbacks before deleting session state.

**Background (verified):** When a session is busy, a second `prompt()` parks itself in `state()[sessionID].callbacks` and awaits (prompt.ts:388-394). `cancel()` calls `match.abort.abort()` then `delete s[sessionID]` (376-377) WITHOUT settling those callbacks. The loop-completion block reads `state()[sessionID]?.callbacks ?? []` (1272) — state is already deleted → `[]` → parked awaiters never settle → the second `prompt()` hangs forever.

- [ ] **Step 1: Write the failing test** — create `test/session/cancel-queued.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

// A promise parked in a session's callbacks must be rejected when the session is cancelled,
// not left dangling. We assert on the settle behavior via a direct callbacks injection.
test("cancel rejects queued callbacks instead of leaking them", async () => {
  // Access the internal state through the exported cancel path: build a session entry with a parked callback.
  const rejected = new Promise<string>((_resolve, reject) => {
    SessionPrompt.__test_parkCallback?.("ses_hang", reject)
  })
  SessionPrompt.cancel("ses_hang")
  await expect(rejected).rejects.toThrow()
})
```

Note: this test needs a tiny test-only hook. In `src/session/prompt.ts`, export it near the other exports:

```typescript
  // Test-only: park a reject callback on a synthetic session entry.
  export function __test_parkCallback(sessionID: string, reject: (e: any) => void) {
    const s = state()
    s[sessionID] = { ...(s[sessionID] ?? {}), callbacks: [...(s[sessionID]?.callbacks ?? []), { resolve: () => {}, reject }] } as any
  }
```

If the session entry shape makes a synthetic partial unsafe to construct, instead write the test to drive a real busy session (start one prompt, await-race a second, cancel) — but the synthetic hook is preferred for determinism. Confirm the `state()` entry shape when implementing and adjust the synthetic object to satisfy the type (cast `as any` is acceptable in a test-only helper).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/session/cancel-queued.test.ts` — Expected: FAIL (promise never rejects → test times out).

- [ ] **Step 3: Reject parked callbacks in `cancel`** — in `src/session/prompt.ts`, change `cancel` (367-379). After `match.abort.abort()` and before `delete s[sessionID]`, settle the callbacks:

```typescript
    match.abort.abort()
    for (const cb of match.callbacks ?? []) {
      cb.reject(new Error("session cancelled"))
    }
    delete s[sessionID]
```

- [ ] **Step 4: Do the same in the `Instance.state` disposer** — at the disposer (~90-94) that aborts on teardown, reject parked callbacks before/alongside the abort so instance teardown does not leak waiters. Locate the disposer body (it iterates sessions and calls `.abort.abort()`); for each session entry add:

```typescript
      for (const cb of entry.callbacks ?? []) {
        cb.reject(new Error("instance disposed"))
      }
```

(match the existing loop variable name; if the disposer aborts a single `match`, mirror the Step 3 shape.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/session/cancel-queued.test.ts` — Expected: PASS.
Regression: `bun test test/session/` — Expected: no new failures.

- [ ] **Step 6: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/session/prompt.ts test/session/cancel-queued.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/aboocode/src/session/prompt.ts packages/aboocode/test/session/cancel-queued.test.ts
git commit -m "fix(session): cancel rejects queued prompt callbacks instead of leaking them"
```

---

### Task 6: Workflow — atomic resume claim closes the concurrent-resume TOCTOU (#7)

**Files:**
- Modify: `src/workflow/run.ts` (the `start` guard ~144-167; the `liveRuns` Set declaration)
- Test: `test/workflow/resume-toctou.test.ts` (new)

**Interfaces:**
- Consumes: `WorkflowRun.start({ resumeFromRunId })`, module-level `liveRuns: Set<string>`.
- Produces: `start` claims `resumeFromRunId` in `liveRuns` SYNCHRONOUSLY before its first `await`; a second concurrent resume of the same run is refused.

**Background (verified):** `liveRuns.add(runId)` happens inside `drive()` (run.ts:47), AFTER `start()` has awaited `getRun` and `setStatus`. Two `start({resumeFromRunId})` calls interleave across those awaits: both read a resumable (non-"running") status, both skip the liveness check, both `setStatus("running")`, both `drive` the same runId → duplicate `workflow_agent_call` rows at the same seq, racing `tokens_total`, and duplicated real side effects.

- [ ] **Step 1: Write the failing test** — create `test/workflow/resume-toctou.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowRun } from "../../src/workflow/run"

// Two concurrent resumes of the same runId: exactly one may proceed; the other must be refused.
test("concurrent resume of the same run is refused for the second caller", async () => {
  // claimResume is the synchronous claim primitive extracted from start().
  const first = WorkflowRun.__claimResume("wfr_dupe")
  const second = WorkflowRun.__claimResume("wfr_dupe")
  expect(first).toBe(true)
  expect(second).toBe(false)
  WorkflowRun.__releaseResume("wfr_dupe")
  expect(WorkflowRun.__claimResume("wfr_dupe")).toBe(true)
  WorkflowRun.__releaseResume("wfr_dupe")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/workflow/resume-toctou.test.ts` — Expected: FAIL (`__claimResume` undefined).

- [ ] **Step 3: Add the synchronous claim primitive** — in `src/workflow/run.ts`, near the `liveRuns` declaration add:

```typescript
  // Synchronous claim: returns false if runId is already claimed/live in this process.
  // Called BEFORE any await in start() so two concurrent resumes cannot both proceed.
  export function __claimResume(runId: string): boolean {
    if (liveRuns.has(runId)) return false
    liveRuns.add(runId)
    return true
  }
  export function __releaseResume(runId: string): void {
    liveRuns.delete(runId)
  }
```

(If `liveRuns` is currently a plain `const liveRuns = new Set<string>()`, keep it; these helpers just wrap it. The `__` prefix marks them internal/test-facing but they are the real primitive used below.)

- [ ] **Step 4: Claim synchronously at the top of `start` for resumes** — in `start({ resumeFromRunId, ... })`, before the first `await` (before `getRun`), add:

```typescript
    if (resumeFromRunId) {
      if (!__claimResume(resumeFromRunId)) throw new Error(`workflow ${resumeFromRunId} is already running in this process`)
    }
```

Then remove the now-redundant `liveRuns.add(runId)` inside `drive()` for the resume path (keep a single source of truth — the claim). Ensure `__releaseResume(runId)` is called in `drive()`'s `finally` (where `liveRuns.delete` currently happens) so a crashed run frees its claim. For the fresh-run (non-resume) path, keep the existing `liveRuns.add` in `drive()` unchanged. Verify the existing stale-"running" reset logic (run.ts:150-151) still runs only for genuinely non-claimed rows.

- [ ] **Step 5: Run test + regression**

Run: `bun test test/workflow/resume-toctou.test.ts test/workflow/` — Expected: PASS; existing workflow run/resume tests (including "refuses a run that is live in this process") still pass.

- [ ] **Step 6: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/workflow/run.ts test/workflow/resume-toctou.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/aboocode/src/workflow/run.ts packages/aboocode/test/workflow/resume-toctou.test.ts
git commit -m "fix(workflow): claim resume synchronously to close concurrent-resume TOCTOU"
```

---

### Task 7: Workflow — resume correctness: budget double-count, failed-as-null, child memoization (#11, #13, #12)

**Files:**
- Modify: `src/workflow/engine.ts` (`agent` resume path ~18-21; `budget.add` sites)
- Modify: `src/workflow/journal.ts` (`lookup` return shape; `invalidateFrom` return value)
- Modify: `src/workflow/budget.ts` (add `sub`)
- Modify: `src/workflow/run.ts` (`child` — journal + seq the child call)
- Test: `test/workflow/resume-correctness.test.ts` (new)

**Interfaces:**
- Consumes: `WorkflowJournal.lookup(seq): { callKey, result, status } | undefined`, `WorkflowJournal.invalidateFrom(seq): Promise<number>` (returns freed tokens), `WorkflowBudget.create(total, used)`, `ctx.child(ref, args)`.
- Produces: `budget.sub(n)`; `lookup` includes `status`; `invalidateFrom` returns freed token count; `child()` records a parent-journal row keyed by a parent seq.

**Background (verified):**
- **#11:** On divergence, `invalidateFrom(seq)` (engine.ts:21) subtracts tokens from the DB `tokens_total` but NOT from in-memory `budget.used` (seeded from prior `tokens_total`), so the re-executed tail double-counts.
- **#13:** `lookup` returns a row regardless of `status`; failed calls (`result:null`) short-circuit to `null` on resume (engine.ts:20) and never retry.
- **#12:** `child()` (run.ts:85) always `createRun`s a fresh child and re-evaluates it; the call is never recorded in the parent journal nor consumes a parent seq, so parent resume re-runs the whole child.

- [ ] **Step 1: Write the failing tests** — create `test/workflow/resume-correctness.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowBudget } from "../../src/workflow/budget"

test("budget.sub decrements used so invalidated tokens are reclaimed", () => {
  const b = WorkflowBudget.create(100, 80)
  expect(b.remaining()).toBe(20)
  b.sub(40)
  expect(b.remaining()).toBe(60)
  b.add(40)
  expect(b.remaining()).toBe(20)
})
```

Add, once `lookup`/`invalidateFrom` shapes are updated, an integration-style assertion in the same file that a failed journaled call is NOT short-circuited on resume — dispatch via the existing workflow test harness pattern (mirror `test/workflow/integration.test.ts`): record a `status:"failed"` row, resume, assert the agent re-spawns. Keep the budget unit test as the RED anchor.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/workflow/resume-correctness.test.ts` — Expected: FAIL (`b.sub` undefined).

- [ ] **Step 3: Add `budget.sub`** — in `src/workflow/budget.ts`, alongside `add`:

```typescript
    sub(n: number) {
      used = Math.max(0, used - n)
    },
```

(mirror the closure-variable style of `add`; if `used` is a captured `let`, decrement it; clamp at 0.)

- [ ] **Step 4: Make `invalidateFrom` return freed tokens and `lookup` expose status** — in `src/workflow/journal.ts`:
  - `invalidateFrom(seq)`: sum the `tokens` of the rows being deleted, decrement `tokens_total` by that sum (existing behavior), and `return` the summed freed tokens.
  - `lookup(seq)`: include `status` in the returned object (`{ callKey, result, status }`).

- [ ] **Step 5: Fix the `agent` resume path** — in `src/workflow/engine.ts` (18-21), replace:

```typescript
      if (ctx.resume) {
        const cached = await ctx.journal.lookup(seq)
        if (cached && cached.callKey === callKey) return cached.result
        if (cached) await ctx.journal.invalidateFrom(seq)
      }
```

with:

```typescript
      if (ctx.resume) {
        const cached = await ctx.journal.lookup(seq)
        // Only replay a committed success. A failed row (transient error) must re-run.
        if (cached && cached.callKey === callKey && cached.status !== "failed") return cached.result
        if (cached) {
          const freed = await ctx.journal.invalidateFrom(seq)
          ctx.budget.sub(freed) // keep in-memory budget consistent with the DB (#11)
        }
      }
```

- [ ] **Step 6: Journal + seq the `child()` call** — in `src/workflow/run.ts` `child` (85-115), wrap it so the parent resume can skip a completed child. Assign a parent seq and a callKey and short-circuit on resume:

```typescript
        child: async (ref, childArgs) => {
          if (ctx.depth >= 1) throw new Error("workflow() nesting is limited to one level")
          const seq = ctx.nextSeq()
          const callKey = WorkflowJournal.callKey(seq, `workflow:${ref}`, { args: childArgs } as any)
          if (ctx.resume) {
            const cached = await ctx.journal.lookup(seq)
            if (cached && cached.callKey === callKey && cached.status !== "failed") return cached.result
            if (cached) {
              const freed = await ctx.journal.invalidateFrom(seq)
              ctx.budget.sub(freed)
            }
          }
          const resolved = await resolveRef(ref)
          const childMeta = WorkflowRuntime.parseMeta(resolved.source)
          const childRunId = await WorkflowJournal.createRun({
            sessionID: input.sessionID,
            name: childMeta.name,
            scriptPath: resolved.scriptPath,
            model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
            args: childArgs,
          })
          let childSeq = 0
          const childCtx: WorkflowTypes.RunContext = {
            ...ctx,
            runId: childRunId,
            args: childArgs,
            resume: false,
            depth: ctx.depth + 1,
            nextSeq: () => childSeq++,
            journal: WorkflowJournal.bind(childRunId),
            child: () => Promise.reject(new Error("workflow() nesting is limited to one level")),
          }
          try {
            const value = await WorkflowRuntime.evaluate(resolved.source, WorkflowEngine.build(childCtx) as any)
            await WorkflowJournal.setStatus(childRunId, "done")
            await ctx.journal.record({ seq, callKey, label: `workflow:${childMeta.name}`, phase: currentPhase, prompt: `workflow:${ref}`, opts: { args: childArgs } as any, result: value, tokens: 0, status: "done" })
            return value
          } catch (e) {
            await WorkflowJournal.setStatus(childRunId, ctx.abort.aborted ? "stopped" : "failed")
            throw e
          }
        },
```

Note: `currentPhase` may not be in scope inside `run.ts`'s `child`; if not, pass `phase: undefined` (the journal row's phase is display-only for a child). The `tokens: 0` on the parent row is intentional — child token spend lives in the child run's own rows (the parent_run_id rollup remains a separately-tracked follow-up, out of scope here). The goal of THIS change is idempotent resume, not accounting rollup.

- [ ] **Step 7: Run tests + regression**

Run: `bun test test/workflow/resume-correctness.test.ts test/workflow/` — Expected: PASS; existing workflow tests (integration/resume/journal) still pass.

- [ ] **Step 8: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/workflow/engine.ts src/workflow/journal.ts src/workflow/budget.ts src/workflow/run.ts test/workflow/resume-correctness.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/aboocode/src/workflow/engine.ts packages/aboocode/src/workflow/journal.ts packages/aboocode/src/workflow/budget.ts packages/aboocode/src/workflow/run.ts packages/aboocode/test/workflow/resume-correctness.test.ts
git commit -m "fix(workflow): resume reclaims budget, retries failed calls, memoizes child workflows"
```

---

### Task 8: MCP — Claude Code remote (SSE/HTTP) servers map to `remote` so they connect (#8)

**Files:**
- Modify: `src/mcp/claude-code-compat.ts` (`convert` ~82-102; the `CompatMcpEntry` type if it enumerates `sse`/`http`)
- Test: `test/mcp/claude-code-compat.test.ts` (extend if it exists, else create)

**Interfaces:**
- Consumes: `MCP.create` branches on `mcp.type === "remote" | "local"` only (mcp/index.ts:321,425).
- Produces: `convert` emits `{ type: "remote", url, headers }` for both SSE and HTTP Claude Code entries.

**Background (verified):** `convert` returns `{type:"sse"}` / `{type:"http"}` (compat.ts:94,98). `create` has no branch for those → falls through to `status = { status:"failed", error:"Unknown error" }` (mcp/index.ts:469-473). Every Claude Code remote MCP server silently fails to connect; only stdio (→ `local`) works.

- [ ] **Step 1: Write the failing test** — create/extend `test/mcp/claude-code-compat.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { ClaudeCodeCompat } from "../../src/mcp/claude-code-compat"

test("SSE and HTTP Claude Code servers convert to remote so MCP.create can connect them", () => {
  const sse = ClaudeCodeCompat.__convert?.({ type: "sse", url: "https://x/sse" } as any)
    ?? ClaudeCodeCompat.convert?.({ type: "sse", url: "https://x/sse" } as any)
  expect(sse?.type).toBe("remote")
  expect(sse?.url).toBe("https://x/sse")
  const http = (ClaudeCodeCompat.__convert ?? ClaudeCodeCompat.convert)?.({ type: "http", url: "https://x/mcp", headers: { a: "b" } } as any)
  expect(http?.type).toBe("remote")
  expect(http?.headers).toEqual({ a: "b" })
})
```

If `convert` is a private module function (not exported), export it (or a thin `__convert` alias) so it is testable. Confirm the export name when implementing; use whichever the module already exposes and drop the `??` fallback.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/mcp/claude-code-compat.test.ts` — Expected: FAIL (`type` is `"sse"`/`"http"`, not `"remote"`).

- [ ] **Step 3: Map SSE and HTTP to `remote`** — in `src/mcp/claude-code-compat.ts` `convert`, replace the two branches (94, 98):

```typescript
  if (rawType === "sse") {
    if (!entry.url) return null
    return { type: "sse", url: entry.url, headers: entry.headers }
  }
  if (rawType === "http" || rawType === "streamable" || rawType === "streamable-http") {
    if (!entry.url) return null
    return { type: "http", url: entry.url, headers: entry.headers }
  }
```

with a single remote mapping:

```typescript
  if (rawType === "sse" || rawType === "http" || rawType === "streamable" || rawType === "streamable-http") {
    if (!entry.url) return null
    return { type: "remote", url: entry.url, headers: entry.headers }
  }
```

Update `CompatMcpEntry` (and any union type it feeds) so `remote` with `url`/`headers` is valid and `sse`/`http` variants are removed if they existed only for this path. Verify `MCP.create`'s remote branch reads `url` and `headers` (it does for native remote configs); if headers are threaded differently there, match that shape.

- [ ] **Step 4: Run test + regression**

Run: `bun test test/mcp/claude-code-compat.test.ts` — Expected: PASS.

- [ ] **Step 5: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/mcp/claude-code-compat.ts test/mcp/claude-code-compat.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/aboocode/src/mcp/claude-code-compat.ts packages/aboocode/test/mcp/claude-code-compat.test.ts
git commit -m "fix(mcp): map Claude Code SSE/HTTP servers to remote so they connect"
```

---

### Task 9: Storage — restore `synchronous = NORMAL` after the first-run migration (#9)

**Files:**
- Modify: `src/storage/json-migration.ts` (~49-52 and the migration teardown)
- Test: `test/storage/json-migration-pragma.test.ts` (new)

**Interfaces:**
- Consumes: the `sqlite` client passed to `JsonMigration.run` (the shared `Database.Client().$client`).
- Produces: `synchronous` is restored to `NORMAL` on the shared connection when the migration finishes (success or failure).

**Background (verified):** `JsonMigration.run` sets `PRAGMA synchronous = OFF` (line 50) on the SHARED live connection (`index.ts:96` passes `Database.Client().$client`) and never restores it. PRAGMA is per-connection and persistent, so the entire first-run process then writes with `synchronous = OFF` — a power-loss/kill during that session can corrupt the DB.

- [ ] **Step 1: Write the failing test** — create `test/storage/json-migration-pragma.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { JsonMigration } from "../../src/storage/json-migration"

test("migration restores synchronous to NORMAL on the shared connection", async () => {
  const sqlite = new BunDatabase(":memory:")
  // Run the migration with an empty source (no JSON dir) — it should still restore the pragma.
  await JsonMigration.run(sqlite, { sourceDir: "/nonexistent-json-source" } as any).catch(() => {})
  const [{ synchronous }] = sqlite.query("PRAGMA synchronous").all() as any[]
  // NORMAL === 1; OFF === 0. Must not be left at OFF.
  expect(synchronous).not.toBe(0)
})
```

Confirm `JsonMigration.run`'s second-arg shape when implementing (it takes an options object with the source directory / stats); pass a minimal valid options object and tolerate a no-op migration.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/storage/json-migration-pragma.test.ts` — Expected: FAIL (`synchronous === 0`).

- [ ] **Step 3: Restore the pragma in a `finally`** — in `src/storage/json-migration.ts`, wrap the migration body so the durability pragma is always restored. Around the bulk-insert work that follows the four `PRAGMA` lines, ensure:

```typescript
    sqlite.exec("PRAGMA journal_mode = WAL")
    sqlite.exec("PRAGMA synchronous = OFF")
    sqlite.exec("PRAGMA cache_size = 10000")
    sqlite.exec("PRAGMA temp_store = MEMORY")
    try {
      // ... existing migration body (all inserts / stats) ...
      return stats
    } finally {
      // Restore durable writes on the shared connection (#9).
      sqlite.exec("PRAGMA synchronous = NORMAL")
    }
```

(Wrap exactly the existing body between the pragmas and the current `return stats` in the `try`; move the `return stats` inside. Do not change `journal_mode`/`cache_size`/`temp_store` — only `synchronous` is the durability hazard on the shared connection.)

- [ ] **Step 4: Run test + regression**

Run: `bun test test/storage/json-migration-pragma.test.ts test/storage/` — Expected: PASS; existing migration tests still pass (idempotency unaffected).

- [ ] **Step 5: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/storage/json-migration.ts test/storage/json-migration-pragma.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/aboocode/src/storage/json-migration.ts packages/aboocode/test/storage/json-migration-pragma.test.ts
git commit -m "fix(storage): restore synchronous=NORMAL after first-run migration"
```

---

### Task 10: Config — project `.aboocode` must override home `~/.aboocode` (#10)

**Files:**
- Modify: `src/config/config.ts` (the `directories` array construction ~133-152)
- Test: `test/config/precedence.test.ts` (new)

**Interfaces:**
- Consumes: `Config.get()`, the `directories` merge loop (later entry wins).
- Produces: `directories` ordered `[global config, home ~/.aboocode, ...project .aboocode]` so project wins.

**Background (verified):** `directories` is `[Global.Path.config, ...project .aboocode, ...home ~/.aboocode]` and the merge loop applies `result = merge(result, loadFile(dir))` in order (later wins). Home is appended LAST → home overrides project for every scalar/object key, contradicting the documented "local overrides global" priority (`deduplicatePlugins`).

- [ ] **Step 1: Write the failing test** — create `test/config/precedence.test.ts`:

```typescript
import { test, expect } from "bun:test"

// Unit-level ordering assertion: given the same key in home and project sources,
// project must win. We assert the intended ordering of the directories array:
// project entries appear AFTER home so the merge (later-wins) resolves to project.
test("directories order puts project after home (project wins on merge)", () => {
  // Simulate the ordering contract: home first, project last.
  const order = ["<global>", "<home/.aboocode>", "<project/.aboocode>"]
  const homeIdx = order.indexOf("<home/.aboocode>")
  const projIdx = order.indexOf("<project/.aboocode>")
  expect(projIdx).toBeGreaterThan(homeIdx)
})
```

This encodes the contract; the real enforcement is the reordering in Step 3. If the codebase has an integration harness that writes both `~/.aboocode/aboocode.json` and `<project>/.aboocode/aboocode.json` with a conflicting key, prefer that end-to-end assertion (project value wins) and drop the ordering stub.

- [ ] **Step 2: Run test**

Run: `bun test test/config/precedence.test.ts` — Expected: PASS (contract stub) — this task's true verification is the reorder + full config suite in Step 4.

- [ ] **Step 3: Reorder so home precedes project** — in `src/config/config.ts`, change the `directories` array so the home scan comes BEFORE the project scan:

```typescript
    const directories = [
      Global.Path.config,
      // Home ~/.aboocode is scanned BEFORE project so project .aboocode wins on merge (later-wins).
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".aboocode"],
          start: Global.Path.home,
          stop: Global.Path.home,
        }),
      )),
      // Project .aboocode directories (highest priority) — scanned last.
      ...(!Flag.ABOOCODE_DISABLE_PROJECT_CONFIG
        ? await Array.fromAsync(
            Filesystem.up({
              targets: [".aboocode"],
              start: Instance.directory,
              stop: Instance.worktree,
            }),
          )
        : []),
    ]
```

Verify `deduplicatePlugins` (config.ts:518-528) still behaves: it reverse-dedups plugins, so a project plugin still wins; confirm its expectation of directory order isn't inverted by this change (read its comment; if it assumes project-first, adjust its iteration to match the new order or confirm it operates on the already-merged result and is order-independent).

- [ ] **Step 4: Run config suite**

Run: `bun test test/config/` — Expected: PASS (no regression); the reorder does not break plugin dedup or existing precedence tests.

- [ ] **Step 5: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/config/config.ts test/config/precedence.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/aboocode/src/config/config.ts packages/aboocode/test/config/precedence.test.ts
git commit -m "fix(config): project .aboocode overrides home ~/.aboocode"
```

---

### Task 11: LOW batch A — grep empty lines, `$ARGUMENTS` token safety, config `{file:X}` global, edit fuzzy `replaceAll` (LOW)

**Files:**
- Modify: `src/tool/grep.ts:87-88`
- Modify: `src/session/prompt.ts:2445`
- Modify: `src/config/config.ts:1364`
- Modify: `src/tool/edit.ts:635-645`
- Test: `test/tool/grep-empty-line.test.ts` (new); `test/tool/edit-replace-all-fuzzy.test.ts` (new)

**Interfaces:** none change; all are internal correctness fixes.

**Background (verified):**
- grep drops matches whose line text is empty (`lineTextParts.length === 0` continue) → `^$`/`^\s*$` hits under-count.
- `$ARGUMENTS` substitution uses `replaceAll("$ARGUMENTS", input.arguments)` — a string replacement, so `$&`/`$$`/`` $` ``/`$'` in user input are interpreted, not inserted literally.
- config `{file:X}` uses `text.replace(match, () => ...)` (function replacer is token-safe, already correct) but replaces only the FIRST occurrence of `match`; a second identical `{file:foo}` is left literal.
- edit `replaceAll` with a fuzzy replacer does `content.replaceAll(firstMatch, newString)` — replaces only occurrences byte-identical to the first fuzzy match; whitespace-divergent occurrences are silently skipped.

- [ ] **Step 1: Write the failing tests** —

`test/tool/grep-empty-line.test.ts`:

```typescript
import { test, expect } from "bun:test"

// Parsing contract: an empty line-text field (trailing "|") must NOT be dropped.
function parseLine(line: string) {
  const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
  // FIXED predicate: only require path + line number; empty text is a valid match.
  if (!filePath || !lineNumStr) return null
  return { filePath, lineNum: parseInt(lineNumStr, 10), lineText: lineTextParts.join("|") }
}

test("a grep hit on an empty line is retained", () => {
  expect(parseLine("file.ts|42|")).toEqual({ filePath: "file.ts", lineNum: 42, lineText: "" })
})
```

`test/tool/edit-replace-all-fuzzy.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { Edit } from "../../src/tool/edit"

// replaceAll across whitespace-divergent occurrences (fuzzy) must replace ALL, not just the first shape.
test("replaceAll replaces every fuzzy occurrence", () => {
  const content = "foo( a )\nfoo(a)\n"
  const out = Edit.__replace?.(content, "foo(a)", "bar()", true) ?? content
  expect(out).not.toContain("foo(")
})
```

If the replace routine is not exported, export a thin `__replace(content, oldString, newString, replaceAll)` wrapper around the existing replacer loop for testability, or drive it through the public `Edit` tool with a temp file. Confirm the actual function name when implementing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/tool/grep-empty-line.test.ts test/tool/edit-replace-all-fuzzy.test.ts` — Expected: grep test PASSES (documents the fixed predicate); edit test FAILS (`foo( a )` remains).

- [ ] **Step 3: Fix grep** — in `src/tool/grep.ts:87-88`, change:

```typescript
      if (!filePath || !lineNumStr || lineTextParts.length === 0) continue
```

to:

```typescript
      if (!filePath || !lineNumStr) continue
```

(the subsequent `lineText = lineTextParts.join("|")` yields `""` for an empty match, which is correct.)

- [ ] **Step 4: Fix `$ARGUMENTS` token safety** — in `src/session/prompt.ts:2445`, change:

```typescript
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)
```

to a function replacer so replacement-token sequences in user input are inserted literally:

```typescript
    let template = withArgs.replace(/\$ARGUMENTS/g, () => input.arguments)
```

- [ ] **Step 5: Fix config `{file:X}` to replace all occurrences** — in `src/config/config.ts:1364`, change:

```typescript
        text = text.replace(match, () => JSON.stringify(fileContent).slice(1, -1))
```

to replace every occurrence of that exact placeholder (escape regex metachars in `match`):

```typescript
        const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        text = text.replace(new RegExp(escaped, "g"), () => JSON.stringify(fileContent).slice(1, -1))
```

- [ ] **Step 6: Fix edit fuzzy `replaceAll`** — in `src/tool/edit.ts` (635-645), when `replaceAll` is set, replace EVERY fuzzy match the replacer can find, not just the first. Change the `if (replaceAll) { return content.replaceAll(search, newString) }` to iterate the replacer's yields and apply each:

```typescript
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        // Replace this concrete match everywhere it appears; keep scanning the
        // generator so whitespace-divergent occurrences are also covered.
        content = content.replaceAll(search, newString)
        continue
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
    if (replaceAll && !notFound) return content
```

(Requires `content` to be a mutable `let` within this scope — confirm/convert. The trailing `if (replaceAll && !notFound) return content` returns the accumulated result after the loop. The single-replace path is unchanged.)

- [ ] **Step 7: Run tests + regression**

Run: `bun test test/tool/grep-empty-line.test.ts test/tool/edit-replace-all-fuzzy.test.ts test/tool/ test/config/ test/session/` — Expected: PASS; existing edit/grep/config/session tests unaffected.

- [ ] **Step 8: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/tool/grep.ts src/session/prompt.ts src/config/config.ts src/tool/edit.ts test/tool/grep-empty-line.test.ts test/tool/edit-replace-all-fuzzy.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/aboocode/src/tool/grep.ts packages/aboocode/src/session/prompt.ts packages/aboocode/src/config/config.ts packages/aboocode/src/tool/edit.ts packages/aboocode/test/tool/grep-empty-line.test.ts packages/aboocode/test/tool/edit-replace-all-fuzzy.test.ts
git commit -m "fix(tools): grep empty-line matches, \$ARGUMENTS token safety, config file-subst global, edit fuzzy replaceAll"
```

---

### Task 12: LOW batch B — OAuth cancelPending key, background kill await, MCP-prompt skill command dedupe (LOW)

**Files:**
- Modify: `src/mcp/oauth-callback.ts` (`cancelPending` ~152-159; the pending map keying)
- Modify: `src/session/background.ts` (`kill` ~111-125)
- Modify: `src/command/index.ts` (the skill→command registration loop ~329-341)
- Test: `test/mcp/oauth-cancel.test.ts` (new)

**Interfaces:**
- Consumes: `pendingAuths` (keyed by `oauthState`), `MCP.removeAuth(name) → cancelPending(name)`, `Background.kill(taskID)`, the skill registration loop.
- Produces: `cancelPending(mcpName)` resolves to the right pending entry via a name→state index; `kill` awaits cancellation; MCP-source skills are not registered as empty-template commands.

**Background (verified):**
- `pendingAuths` is keyed by the random `oauthState` (oauth-callback.ts:148); `cancelPending(mcpName)` does `pendingAuths.get(mcpName)` — never matches, so cancel is a no-op (the wait lingers to its 5-min timeout).
- `Background.kill` sets `status="failed"` + `delete state()[taskID]` and returns `true` synchronously while cancellation is a fire-and-forget import — the tool reports success before cancel runs.
- `buildMcpSkills` sets `content: ""` (mcp-builders.ts:44); `command/index.ts` registers every skill as a command whose template is `skill.content` — empty for MCP-prompt skills. These prompts are ALSO registered correctly and separately at command/index.ts:301-326 (`<client>:<prompt>`), so the empty duplicate is pure noise.

- [ ] **Step 1: Write the failing test** — create `test/mcp/oauth-cancel.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { OAuthCallback } from "../../src/mcp/oauth-callback"

test("cancelPending rejects the in-flight wait for a named server", async () => {
  // Start a wait (registers under an internal oauthState) tagged with the mcp name,
  // then cancel by name — the wait must reject promptly, not hang to timeout.
  const state = OAuthCallback.__registerPending?.("my-server")
  const wait = OAuthCallback.__waitFor?.(state)
  OAuthCallback.cancelPending("my-server")
  await expect(wait).rejects.toThrow("cancelled")
})
```

Adapt to the module's real surface: the fix introduces a `name → oauthState` index so `cancelPending(name)` can find the state. If exposing `__registerPending`/`__waitFor` is awkward, test the index directly (a `Map<string,string>` from name to state) via a small exported helper. Confirm the namespace name (`OAuthCallback` vs the actual export) when implementing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/mcp/oauth-cancel.test.ts` — Expected: FAIL (cancel is a no-op → wait never rejects → timeout).

- [ ] **Step 3: Key cancellation by name** — in `src/mcp/oauth-callback.ts`, add a `nameToState = new Map<string, string>()`. When a wait is registered for a server, record `nameToState.set(mcpName, oauthState)` (thread the `mcpName` into `waitForCallback`; if it isn't a parameter yet, add it). Rewrite `cancelPending`:

```typescript
  export function cancelPending(mcpName: string): void {
    const oauthState = nameToState.get(mcpName)
    if (!oauthState) return
    nameToState.delete(mcpName)
    const pending = pendingAuths.get(oauthState)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingAuths.delete(oauthState)
      pending.reject(new Error("Authorization cancelled"))
    }
  }
```

Also clear `nameToState` on the success and timeout paths (wherever `pendingAuths.delete(oauthState)` happens) so the index does not leak.

- [ ] **Step 4: Make `kill` await cancellation** — in `src/session/background.ts`, change `kill` to await the cancel before reporting success, and correct the stale doc comment. Convert to `async`:

```typescript
  /**
   * Kill a background task: cancel its session loop (aborting the LLM stream),
   * then mark it failed. Awaits cancellation so callers don't report success early.
   */
  export async function kill(taskID: string): Promise<boolean> {
    const task = state()[taskID]
    if (!task || task.status !== "running") return false
    const { SessionPrompt } = await import("./prompt")
    SessionPrompt.cancel(task.sessionID)
    task.status = "failed"
    task.error = "Task killed by user"
    task.endTime = Date.now()
    delete state()[taskID]
    return true
  }
```

Update callers of `Background.kill` (the task tool) to `await` it. Search: `grep -rn "\.kill(" src/tool src/session` — update each call site to `await`.

- [ ] **Step 5: Skip MCP-source skills in command registration** — in `src/command/index.ts`, the loop that registers skills as commands (~329-341), skip `source === "mcp"` (they are registered correctly elsewhere at 301-326):

```typescript
    for (const skill of skills) {
      if (skill.source === "mcp") continue // MCP prompts are registered as <client>:<prompt> commands separately
      // ... existing registration using skill.content ...
    }
```

Confirm the loop variable and the `skills` source field name when implementing.

- [ ] **Step 6: Run test + regression**

Run: `bun test test/mcp/oauth-cancel.test.ts test/mcp/ test/session/ test/command/` — Expected: PASS; no regressions (command reload test still sees the full bundled set; MCP-prompt commands still resolve via the `<client>:<prompt>` path).

- [ ] **Step 7: Typecheck + width**

Run: `bun run typecheck` and `awk 'length > 120 {print FNR": "length}' src/mcp/oauth-callback.ts src/session/background.ts src/command/index.ts test/mcp/oauth-cancel.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/aboocode/src/mcp/oauth-callback.ts packages/aboocode/src/session/background.ts packages/aboocode/src/command/index.ts packages/aboocode/test/mcp/oauth-cancel.test.ts
git commit -m "fix(mcp,session,command): oauth cancel keys by name, kill awaits cancel, skip empty MCP-prompt command"
```

---

## Post-Implementation

After all 12 tasks pass their reviews:

- [ ] Run the full suite: `bun test` (from `packages/aboocode/`) — confirm no new failures beyond the documented baseline skips.
- [ ] Run `bun run typecheck` — confirm only the 4 baseline errors remain.
- [ ] Dispatch the final whole-branch review (most-capable model) over `fix/bug-scan-2026-07-06` vs `master`.
- [ ] Use superpowers:finishing-a-development-branch → **Merge back to master locally** (the user's chosen integration path), then delete the branch.
- [ ] Push + npm patch publish (0.11.2) is a SEPARATE decision — do not publish without explicit user go-ahead.

## Notes / out of scope

- **Parent `tokens_total` child-spend rollup** (parent_run_id accounting) is a pre-existing, separately-tracked follow-up — Task 7 fixes child resume idempotency, NOT accounting rollup.
- **Abort swallowed through `parallel`/`pipeline`** (run reports "done" instead of "stopped") is a known accepted gap from the workflow spec §14; not in this plan's scope (it is behavior-cosmetic, no data loss). Add as a follow-up if desired.
- **Cross-process concurrent resume** (liveRuns is per-process) remains inherent to the in-memory liveness design; Task 6 fixes only the in-process TOCTOU.
- The config precedence reorder (Task 10) is a **behavior change** for users who currently (accidentally) rely on home overriding project — call it out in the release notes.
- `resolveRef` path traversal on `workflow("../..")` refs (scan #5-workflow) is bounded by the vm sandbox + `parseMeta` gate; low risk, deferred. Add a containment check as a follow-up if the workflow feature graduates from experimental.
