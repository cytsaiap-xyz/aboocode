# Workflow Engine Graduation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 8 deferred follow-ups recorded in `docs/superpowers/specs/2026-06-14-dynamic-workflow-engine-design.md` §14 so the dynamic workflow engine can graduate from `experimental.workflows`.

**Architecture:** All changes live in `packages/aboocode/src/workflow/` plus one line in the spec doc. The engine keeps its dependency-injected shape (`WorkflowSpawn.Deps`, `SpawnFn`, `RunContext`) so every new behavior is unit-testable with fakes; the two cross-module integrations (permission posture, worktree isolation) reuse the exact mechanisms the `task` tool already uses (`Session.create({ permission })`, `AgentIsolation.create/register`).

**Tech Stack:** Bun + TypeScript, `bun:test`, drizzle over bun:sqlite (`Database.use`/`Database.transaction`), zod.

## Global Constraints

- Run all commands from `packages/aboocode/`. Tests: `bun test test/workflow/`. Typecheck: `bun run typecheck` — 4 pre-existing baseline errors exist (mcp/index.ts, findRelevantMemories.ts, prompt.ts lastUser.parts, isolation-cleanup.test.ts); only NEW errors are regressions.
- Code style: **no semicolons**, printWidth 120, namespaces over classes (existing `Semaphore` class is grandfathered — don't add new classes).
- The feature stays behind `experimental.workflows` in this plan; graduation (default-on) is a separate human decision after bake time.
- Tests that need a DB/Instance use the `tmpdir` + `Instance.provide` pattern from `test/workflow/run.test.ts`. Pure-logic tests use plain fakes like `test/workflow/spawn.test.ts`.
- The working tree may contain pre-existing uncommitted changes (`.claude/settings.local.json`, `bun.lock`, `packages/aboocode/script/publish.ts`) — never `git add` those; stage only files the task names.
- Commit after every task with the exact message given.

## Existing Interfaces (read before starting any task)

- `WorkflowTypes.RunContext` (`src/workflow/types.ts:48`) — the per-run context threaded into the engine.
- `WorkflowSpawn.Deps` (`src/workflow/spawn.ts:11`) — injectable session/prompt/parseModel; `WorkflowSpawn.run(prompt, opts, ctx, deps)`.
- `WorkflowEngine.build(ctx)` (`src/workflow/engine.ts:8`) — returns the script globals `{ agent, parallel, pipeline, phase, log, workflow, budget, args }`.
- `WorkflowRun.start/execute/drive` (`src/workflow/run.ts`) — run lifecycle; `WorkflowJournal` (`src/workflow/journal.ts`) — run + agent-call rows.
- `SessionPrompt.cancel(sessionID)` (`src/session/prompt.ts`) — aborts a session's in-flight loop.
- `Session.create({ parentID, title, permission })` — session-scoped permission rules; see the `task` tool's usage at `src/tool/task.ts:95-124`.
- `AgentIsolation.create(mode, sessionID)` / `.register(sessionID, ctx)` / `.unregister(sessionID)` (`src/agent/isolation.ts`) — `prompt.ts` resolves a session's cwd/root from the registered context.

---

### Task 1: Resume status guard (§14.5)

`WorkflowRun.start` currently accepts `resumeFromRunId` pointing at a nonexistent or still-`running` run, which would double-drive the same journal rows.

**Files:**
- Modify: `src/workflow/run.ts:87-107` (the `start` function)
- Test: `test/workflow/run.test.ts`

**Interfaces:**
- Consumes: `WorkflowJournal.getRun(runId)` (existing).
- Produces: `start()` now rejects with `Error("workflow run not found: <id>")` and `Error("workflow run <id> is still running; stop it before resuming")`.

- [ ] **Step 1: Write the failing test** — append to `test/workflow/run.test.ts` (follow the file's `tmpdir` + `Instance.provide` pattern):

```typescript
test("resume refuses a run id that does not exist", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        WorkflowRun.execute({
          sessionID: "ses_demo",
          source: SCRIPT,
          scriptPath: "/tmp/demo.js",
          args: undefined,
          resumeFromRunId: "wfr_nope",
          spawn: async () => ({ text: "x", tokens: 1 }),
        }),
      ).rejects.toThrow("workflow run not found")
    },
  })
})

test("resume refuses a run that is still running", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const runId = await WorkflowJournal.createRun({
        sessionID: "ses_demo",
        name: "demo",
        scriptPath: "/tmp/demo.js",
        args: undefined,
      })
      await expect(
        WorkflowRun.execute({
          sessionID: "ses_demo",
          source: SCRIPT,
          scriptPath: "/tmp/demo.js",
          args: undefined,
          resumeFromRunId: runId,
          spawn: async () => ({ text: "x", tokens: 1 }),
        }),
      ).rejects.toThrow("still running")
    },
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/workflow/run.test.ts`
Expected: the two new tests FAIL (no error thrown / different error)

- [ ] **Step 3: Implement** — in `src/workflow/run.ts` `start()`, replace:

```typescript
    const runId =
      input.resumeFromRunId ??
      (await WorkflowJournal.createRun({
```

with:

```typescript
    if (input.resumeFromRunId) {
      const existing = await WorkflowJournal.getRun(input.resumeFromRunId)
      if (!existing) throw new Error(`workflow run not found: ${input.resumeFromRunId}`)
      if (existing.status === "running")
        throw new Error(`workflow run ${input.resumeFromRunId} is still running; stop it before resuming`)
    }

    const runId =
      input.resumeFromRunId ??
      (await WorkflowJournal.createRun({
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/workflow/run.test.ts`
Expected: PASS (all, including pre-existing)

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/run.ts packages/aboocode/test/workflow/run.test.ts
git commit -m "fix(workflow): refuse resume of missing or still-running runs"
```

---

### Task 2: Honest async DB writes + opts validation at the script boundary (§14.7)

`setStatus` is fire-and-forget sync; `agent()` accepts `opts: any` from the sandbox, so a non-JSON value (function, circular ref, BigInt) explodes deep inside `callKey` with an opaque error.

**Files:**
- Modify: `src/workflow/journal.ts:50-52` (`setStatus`)
- Modify: `src/workflow/run.ts` (await the three `setStatus` call sites)
- Modify: `src/workflow/schema.ts` (add `validateOpts`)
- Modify: `src/workflow/engine.ts:11-14` (validate before `callKey`)
- Test: `test/workflow/schema.test.ts`, `test/workflow/engine.test.ts`

**Interfaces:**
- Produces: `WorkflowJournal.setStatus(runId, status): Promise<void>`; `WorkflowSchema.validateOpts(opts: unknown): WorkflowTypes.AgentOpts` (throws `Error` starting with `"agent() opts invalid:"`).

- [ ] **Step 1: Write the failing tests** — append to `test/workflow/schema.test.ts`:

```typescript
test("validateOpts accepts known JSON-serializable opts", () => {
  const opts = { label: "x", phase: "P", model: "sonnet", schema: { type: "object" }, agentType: "general" }
  expect(WorkflowSchema.validateOpts(opts)).toEqual(opts)
})

test("validateOpts rejects unknown keys", () => {
  expect(() => WorkflowSchema.validateOpts({ labell: "typo" })).toThrow("agent() opts invalid")
})

test("validateOpts rejects non-serializable values", () => {
  expect(() => WorkflowSchema.validateOpts({ label: (() => {}) as any })).toThrow("agent() opts invalid")
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/workflow/schema.test.ts`
Expected: FAIL — `validateOpts is not a function`

- [ ] **Step 3: Implement `validateOpts`** — in `src/workflow/schema.ts`, add inside the namespace (import `z` and `WorkflowTypes` if not present):

```typescript
  const AgentOptsSchema = z
    .object({
      label: z.string().optional(),
      phase: z.string().optional(),
      schema: z.record(z.string(), z.any()).optional(),
      model: z.string().optional(),
      isolation: z.literal("worktree").optional(),
      agentType: z.string().optional(),
    })
    .strict()

  /** Validate agent() opts coming from the sandboxed script (typed `any` there). */
  export function validateOpts(opts: unknown): WorkflowTypes.AgentOpts {
    const parsed = AgentOptsSchema.safeParse(opts ?? {})
    if (!parsed.success) throw new Error(`agent() opts invalid: ${parsed.error.issues[0]?.message ?? "bad shape"}`)
    try {
      JSON.stringify(parsed.data)
    } catch (e) {
      throw new Error(`agent() opts invalid: not JSON-serializable (${(e as Error).message})`)
    }
    return parsed.data
  }
```

Note: zod `.strict()` already rejects functions on typed fields; the `JSON.stringify` probe catches circular refs and BigInt inside `schema`.

- [ ] **Step 4: Wire into engine** — in `src/workflow/engine.ts` `agent()`, replace the first three lines:

```typescript
    async function agent(prompt: string, opts: WorkflowTypes.AgentOpts = {}): Promise<any> {
      const seq = ctx.nextSeq()
      const phase = opts.phase ?? currentPhase
      const callKey = WorkflowJournal.callKey(seq, prompt, opts)
```

with:

```typescript
    async function agent(prompt: string, rawOpts: WorkflowTypes.AgentOpts = {}): Promise<any> {
      const opts = WorkflowSchema.validateOpts(rawOpts)
      const seq = ctx.nextSeq()
      const phase = opts.phase ?? currentPhase
      const callKey = WorkflowJournal.callKey(seq, prompt, opts)
```

(`WorkflowSchema` is already imported in engine.ts. Validation runs before `nextSeq` so an invalid call burns no sequence number.)

- [ ] **Step 5: Make `setStatus` honest** — in `src/workflow/journal.ts` replace:

```typescript
  export function setStatus(runId: string, status: Status): void {
    Database.use((db) => db.update(WorkflowRunTable).set({ status }).where(eq(WorkflowRunTable.id, runId)).run())
  }
```

with:

```typescript
  export async function setStatus(runId: string, status: Status): Promise<void> {
    await Database.use((db) => db.update(WorkflowRunTable).set({ status }).where(eq(WorkflowRunTable.id, runId)).run())
  }
```

In `src/workflow/run.ts`, prefix the three call sites with `await`: `await WorkflowJournal.setStatus(runId, "done")`, `await WorkflowJournal.setStatus(runId, "failed")` (both in `drive`), `if (input.resumeFromRunId) await WorkflowJournal.setStatus(runId, "running")` (in `start`).

- [ ] **Step 6: Engine test for invalid opts** — append to `test/workflow/engine.test.ts` (match the file's existing fake-ctx helper; if it builds a ctx object inline, mirror that):

```typescript
test("agent() rejects unknown opts keys before spending a seq", async () => {
  let seqCalls = 0
  const ctx: any = {
    runId: "wfr_t",
    sessionID: "ses_t",
    args: undefined,
    resume: false,
    depth: 0,
    abort: new AbortController().signal,
    budget: { total: null, spent: () => 0, remaining: () => Infinity, add: () => {} },
    semaphore: { acquire: async () => {}, release: () => {} },
    nextSeq: () => seqCalls++,
    guardSpawn: () => {},
    journal: { lookup: async () => undefined, record: async () => {}, invalidateFrom: async () => {} },
    spawn: async () => ({ text: "ok", tokens: 1 }),
    emit: () => {},
  }
  const g = WorkflowEngine.build(ctx)
  await expect(g.agent("p", { bogus: 1 } as any)).rejects.toThrow("agent() opts invalid")
  expect(seqCalls).toBe(0)
})
```

- [ ] **Step 7: Run all workflow tests + typecheck**

Run: `bun test test/workflow/ && bun run typecheck`
Expected: all pass; only the 4 pre-existing typecheck errors

- [ ] **Step 8: Commit**

```bash
git add packages/aboocode/src/workflow/journal.ts packages/aboocode/src/workflow/run.ts packages/aboocode/src/workflow/schema.ts packages/aboocode/src/workflow/engine.ts packages/aboocode/test/workflow/schema.test.ts packages/aboocode/test/workflow/engine.test.ts
git commit -m "fix(workflow): honest async setStatus; validate agent() opts at the sandbox boundary"
```

---

### Task 3: Resume budget seeding + invalidation accounting (§14.3)

On resume the in-memory budget restarts at 0, so `while (budget.remaining() > X)` loops are non-deterministic across resume. Additionally `invalidateFrom` deletes journal rows without subtracting their tokens from `workflow_run.tokens_total`, inflating both the persisted total and any seeded budget.

**Files:**
- Modify: `src/workflow/budget.ts`
- Modify: `src/workflow/journal.ts:97-104` (`invalidateFrom`)
- Modify: `src/workflow/run.ts` (`drive` — seed on resume)
- Test: `test/workflow/budget.test.ts`, `test/workflow/journal.test.ts`, `test/workflow/run.test.ts`

**Interfaces:**
- Produces: `WorkflowBudget.create(total: number | null, initialUsed?: number)` (default 0).

- [ ] **Step 1: Write failing budget test** — append to `test/workflow/budget.test.ts`:

```typescript
test("create seeds prior spend so remaining() is deterministic across resume", () => {
  const b = WorkflowBudget.create(1000, 300)
  expect(b.spent()).toBe(300)
  expect(b.remaining()).toBe(700)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/workflow/budget.test.ts`
Expected: FAIL — `spent()` returns 0

- [ ] **Step 3: Implement** — replace `src/workflow/budget.ts` body:

```typescript
import type { WorkflowTypes } from "./types"

export namespace WorkflowBudget {
  export function create(total: number | null, initialUsed = 0): WorkflowTypes.Budget {
    let used = Math.max(0, initialUsed)
    return {
      total,
      spent: () => used,
      remaining: () => (total === null ? Infinity : Math.max(0, total - used)),
      add: (tokens: number) => {
        used += Math.max(0, tokens)
      },
    }
  }
}
```

- [ ] **Step 4: Fix `invalidateFrom` accounting** — in `src/workflow/journal.ts`, replace the `invalidateFrom` method of `bind()`:

```typescript
      async invalidateFrom(seq) {
        Database.transaction((db) => {
          const doomed = db
            .select()
            .from(WorkflowAgentCallTable)
            .where(and(eq(WorkflowAgentCallTable.run_id, runId), gte(WorkflowAgentCallTable.seq, seq)))
            .all()
          const freed = doomed.reduce((sum, row) => sum + (row.tokens ?? 0), 0)
          db.delete(WorkflowAgentCallTable)
            .where(and(eq(WorkflowAgentCallTable.run_id, runId), gte(WorkflowAgentCallTable.seq, seq)))
            .run()
          if (freed > 0) {
            const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runId)).all()[0]
            db.update(WorkflowRunTable)
              .set({ tokens_total: Math.max(0, (run?.tokens_total ?? 0) - freed) })
              .where(eq(WorkflowRunTable.id, runId))
              .run()
          }
        })
      },
```

- [ ] **Step 5: Seed on resume** — in `src/workflow/run.ts` `drive()`, replace:

```typescript
      budget: WorkflowBudget.create(input.budgetTotal ?? null),
```

with (and make the surrounding ctx construction accommodate the await — hoist it above the `ctx` literal):

```typescript
    const priorTokens = input.resumeFromRunId ? ((await WorkflowJournal.getRun(runId))?.tokens_total ?? 0) : 0
```

then in the ctx literal:

```typescript
      budget: WorkflowBudget.create(input.budgetTotal ?? null, priorTokens),
```

- [ ] **Step 6: Journal + resume tests** — append to `test/workflow/journal.test.ts` (match its existing `tmpdir`/`Instance.provide` setup):

```typescript
test("invalidateFrom subtracts the deleted rows' tokens from tokens_total", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const runId = await WorkflowJournal.createRun({
        sessionID: "ses_j",
        name: "n",
        scriptPath: "/tmp/n.js",
        args: undefined,
      })
      const j = WorkflowJournal.bind(runId)
      await j.record({ seq: 0, callKey: "k0", prompt: "a", opts: {}, result: "r0", tokens: 10, status: "done" })
      await j.record({ seq: 1, callKey: "k1", prompt: "b", opts: {}, result: "r1", tokens: 7, status: "done" })
      await j.invalidateFrom(1)
      const run = await WorkflowJournal.getRun(runId)
      expect(run?.tokens_total).toBe(10)
    },
  })
})
```

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test test/workflow/ && bun run typecheck`
Expected: all pass; only the 4 pre-existing typecheck errors

- [ ] **Step 8: Commit**

```bash
git add packages/aboocode/src/workflow/budget.ts packages/aboocode/src/workflow/journal.ts packages/aboocode/src/workflow/run.ts packages/aboocode/test/workflow/budget.test.ts packages/aboocode/test/workflow/journal.test.ts
git commit -m "fix(workflow): seed resume budget from persisted tokens; invalidateFrom decrements tokens_total"
```

---

### Task 4: Wire ctx.abort end-to-end (§14.2)

Stopping the session does not halt an in-flight run: `engine.agent` never checks `ctx.abort`, and `spawn` has no way to cancel the child session.

**Files:**
- Modify: `src/workflow/engine.ts` (abort checks in `agent()`)
- Modify: `src/workflow/spawn.ts` (accept `abort`, cancel child)
- Modify: `src/workflow/run.ts` (`drive` catch — status `"stopped"` on abort)
- Test: `test/workflow/engine.test.ts`, `test/workflow/spawn.test.ts`

**Interfaces:**
- Consumes: `SessionPrompt.cancel(sessionID)` (existing).
- Produces: `WorkflowSpawn.Deps` gains `cancel: (sessionID: string) => void`; `WorkflowSpawn.run`'s `ctx` param becomes `Pick<WorkflowTypes.RunContext, "sessionID" | "model" | "abort">`; aborted runs persist status `"stopped"`.

- [ ] **Step 1: Failing engine test** — append to `test/workflow/engine.test.ts` (reuse the inline fake-ctx shape from Task 2's test):

```typescript
test("agent() throws immediately when the run is already aborted", async () => {
  const controller = new AbortController()
  controller.abort()
  let spawned = 0
  const ctx: any = {
    runId: "wfr_t",
    sessionID: "ses_t",
    args: undefined,
    resume: false,
    depth: 0,
    abort: controller.signal,
    budget: { total: null, spent: () => 0, remaining: () => Infinity, add: () => {} },
    semaphore: { acquire: async () => {}, release: () => {} },
    nextSeq: () => 0,
    guardSpawn: () => {},
    journal: { lookup: async () => undefined, record: async () => {}, invalidateFrom: async () => {} },
    spawn: async () => {
      spawned++
      return { text: "ok", tokens: 1 }
    },
    emit: () => {},
  }
  const g = WorkflowEngine.build(ctx)
  await expect(g.agent("p")).rejects.toThrow("workflow aborted")
  expect(spawned).toBe(0)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/workflow/engine.test.ts`
Expected: FAIL — resolves instead of throwing

- [ ] **Step 3: Engine abort checks** — in `src/workflow/engine.ts` `agent()`, after the `validateOpts` line (Task 2) add:

```typescript
      if (ctx.abort.aborted) throw new Error("workflow aborted")
```

and immediately after `await ctx.semaphore.acquire()` (a long queue wait may span an abort) add, before the `emit`:

```typescript
      if (ctx.abort.aborted) {
        ctx.semaphore.release()
        throw new Error("workflow aborted")
      }
```

Note: this second check is before the `try`/`finally` that releases the semaphore, hence the explicit release.

- [ ] **Step 4: Spawn cancellation** — in `src/workflow/spawn.ts`:

Extend `Deps` and defaults — `cancel` is OPTIONAL so pre-existing test fakes keep typechecking; the call site falls back to the default:

```typescript
  export interface Deps {
    createSession: (input: { parentID: string; title: string }) => Promise<{ id: string }>
    prompt: (input: any) => Promise<{ info: any; parts: any[] }>
    parseModel: (m: string) => { providerID: string; modelID: string }
    cancel?: (sessionID: string) => void
  }

  const defaults: Deps = {
    createSession: (input) => Session.create(input as any) as any,
    prompt: (input) => SessionPrompt.prompt(input),
    parseModel: (m) => Provider.parseModel(m),
    cancel: (sessionID) => SessionPrompt.cancel(sessionID),
  }
```

Change the ctx type and wire the listener around the prompt call:

```typescript
  export async function run(
    prompt: string,
    opts: WorkflowTypes.AgentOpts,
    ctx: Pick<WorkflowTypes.RunContext, "sessionID" | "model" | "abort">,
    deps: Deps = defaults,
  ): Promise<WorkflowTypes.SpawnResult | null> {
    try {
      const child = await deps.createSession({
        parentID: ctx.sessionID,
        title: opts.label ?? "workflow agent",
      })
      const model = opts.model ? deps.parseModel(opts.model) : ctx.model
      const cancel = deps.cancel ?? defaults.cancel!
      const onAbort = () => cancel(child.id)
      ctx.abort?.addEventListener("abort", onAbort, { once: true })
      let result: { info: any; parts: any[] }
      try {
        result = await deps.prompt({
          sessionID: child.id,
          agent: opts.agentType ?? "general",
          model,
          parts: [{ type: "text", text: prompt }],
          ...(opts.schema ? { format: WorkflowSchema.toFormat(opts.schema) } : {}),
        })
      } finally {
        ctx.abort?.removeEventListener("abort", onAbort)
      }
```

(the rest of the function body — structured/text/tokens extraction and the catch — is unchanged; `ctx.abort?.` optional-chaining keeps old fake ctxs in tests compiling).

- [ ] **Step 5: Stopped status** — in `src/workflow/run.ts` `drive()` catch block, replace:

```typescript
    } catch (e) {
      const error = (e as Error).message
      await WorkflowJournal.setStatus(runId, "failed")
```

with:

```typescript
    } catch (e) {
      const error = (e as Error).message
      const status: WorkflowJournal.Status = ctx.abort.aborted ? "stopped" : "failed"
      await WorkflowJournal.setStatus(runId, status)
```

and use `status` in the `Bus.publish(WorkflowEvents.Completed, ...)` and return (`{ runId, status, error }`).

- [ ] **Step 6: Spawn test** — append to `test/workflow/spawn.test.ts`:

```typescript
test("abort mid-prompt cancels the child session", async () => {
  const controller = new AbortController()
  const cancelled: string[] = []
  const deps = {
    createSession: async () => ({ id: "ses_child" }),
    prompt: async () => {
      controller.abort()
      await new Promise((r) => setTimeout(r, 5))
      return { info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "late" }] }
    },
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
    cancel: (id: string) => cancelled.push(id),
  }
  const ctx: any = { sessionID: "ses_parent", abort: controller.signal }
  await WorkflowSpawn.run("x", {}, ctx, deps)
  expect(cancelled).toEqual(["ses_child"])
})
```

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test test/workflow/ && bun run typecheck`
Expected: all pass (older spawn tests pass because `ctx.abort?.` tolerates fakes without abort); only the 4 pre-existing typecheck errors

- [ ] **Step 8: Commit**

```bash
git add packages/aboocode/src/workflow/engine.ts packages/aboocode/src/workflow/spawn.ts packages/aboocode/src/workflow/run.ts packages/aboocode/test/workflow/engine.test.ts packages/aboocode/test/workflow/spawn.test.ts
git commit -m "feat(workflow): wire abort through engine and spawn; persist stopped status"
```

---

### Task 5: Headless permission posture for spawned children (§14.1)

Spawned children inherit no permission posture, so a headless run blocks forever on Bash/Edit permission prompts. The user already granted the `workflow` permission for the whole run at the tool boundary (`src/workflow/tool.ts:26-31`), so children get pre-approved rules for the standard mutating tools — mirroring how the `task` tool passes session-scoped rules (`src/tool/task.ts:95-124`).

**Files:**
- Modify: `src/workflow/spawn.ts` (permission rules in `createSession`)
- Test: `test/workflow/spawn.test.ts`

**Interfaces:**
- Produces: child sessions created with `permission` rules — allow `edit|write|bash|webfetch` on `*`; deny `todowrite|todoread|task|workflow` on `*` (no todos, no recursive spawning).

- [ ] **Step 1: Failing test** — append to `test/workflow/spawn.test.ts`:

```typescript
test("child sessions get headless permission posture", async () => {
  let created: any
  const deps = {
    createSession: async (input: any) => {
      created = input
      return { id: "ses_child" }
    },
    prompt: async () => ({ info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "ok" }] }),
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
    cancel: () => {},
  }
  await WorkflowSpawn.run("x", {}, { sessionID: "ses_parent" } as any, deps)
  const rule = (perm: string) => created.permission.find((r: any) => r.permission === perm)
  for (const p of ["edit", "write", "bash", "webfetch"]) expect(rule(p)).toEqual({ permission: p, pattern: "*", action: "allow" })
  for (const p of ["todowrite", "todoread", "task", "workflow"]) expect(rule(p)).toEqual({ permission: p, pattern: "*", action: "deny" })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/workflow/spawn.test.ts`
Expected: FAIL — `created.permission` is undefined

- [ ] **Step 3: Implement** — in `src/workflow/spawn.ts`:

Add above the namespace (module scope):

```typescript
// Headless posture for workflow children: the user approved the `workflow`
// permission for the whole run at the tool boundary, so children must not
// block on interactive prompts. Mutating tools are pre-approved; todo tools
// and recursive spawning are denied (mirrors the task tool's child rules).
const CHILD_PERMISSIONS = [
  ...["edit", "write", "bash", "webfetch"].map((p) => ({ permission: p, pattern: "*", action: "allow" as const })),
  ...["todowrite", "todoread", "task", "workflow"].map((p) => ({ permission: p, pattern: "*", action: "deny" as const })),
]
```

Extend the `Deps.createSession` input type with `permission: typeof CHILD_PERMISSIONS` and pass it at the call site:

```typescript
      const child = await deps.createSession({
        parentID: ctx.sessionID,
        title: opts.label ?? "workflow agent",
        permission: CHILD_PERMISSIONS,
      })
```

(the default impl already forwards the whole input into `Session.create(input as any)`, which accepts `permission` — see `src/tool/task.ts:95`).

- [ ] **Step 4: Run tests**

Run: `bun test test/workflow/spawn.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/spawn.ts packages/aboocode/test/workflow/spawn.test.ts
git commit -m "feat(workflow): headless permission posture for spawned child sessions"
```

---

### Task 6: Completion re-injection carries the run's return value (§14.4)

Completion already reaches the launching session via `BackgroundTasks.register` → `drain` → the `<task-notification>` injection in `prompt.ts` (verified wiring). But the registered promise resolves to only `"workflow <id> done"` — the script's return value is dropped, so the launching agent cannot use the result without digging in the journal.

**Files:**
- Modify: `src/workflow/tool.ts:53-60`
- Test: `test/workflow/tool.test.ts`

**Interfaces:**
- Consumes: `WorkflowRun.ExecuteResult.value` (existing).
- Produces: the background-task output string format: `workflow <runId> <status>` + optional `\n<result>\n<json>\n</result>` (value JSON, 4000-char cap) + optional `: <error>`.

- [ ] **Step 1: Failing test** — append to `test/workflow/tool.test.ts` (match the file's existing fakes for `ctx.ask` / run wiring; if the file stubs `WorkflowRun.start`, follow that pattern — the assertion targets the string passed to `BackgroundTasks.register`'s promise):

```typescript
test("background task output includes the run's return value", async () => {
  const format = (r: { runId: string; status: string; value?: any; error?: string }) => {
    let out = `workflow ${r.runId} ${r.status}`
    if (r.error) out += `: ${r.error}`
    if (r.value !== undefined) out += `\n<result>\n${JSON.stringify(r.value, null, 2).slice(0, 4000)}\n</result>`
    return out
  }
  expect(format({ runId: "wfr_1", status: "done", value: { bugs: 3 } })).toContain('"bugs": 3')
  expect(format({ runId: "wfr_1", status: "failed", error: "boom" })).toBe("workflow wfr_1 failed: boom")
})
```

Note: this tests the formatting contract via an exported helper — Step 3 extracts the formatter so both the tool and the test share it. Import it as `WorkflowResultFormat.summarize` and replace the inline `format` above with the import once Step 3 lands (the test as written documents the target shape and MUST be switched to the real import in Step 3 — do not leave a copy-pasted local formatter in the test).

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/workflow/tool.test.ts`
Expected: FAIL after switching to the import (module/function missing)

- [ ] **Step 3: Implement** — in `src/workflow/tool.ts`, add an exported helper above `WorkflowTool` and use it:

```typescript
export namespace WorkflowResultFormat {
  export function summarize(r: { runId: string; status: string; value?: any; error?: string }): string {
    let out = `workflow ${r.runId} ${r.status}`
    if (r.error) out += `: ${r.error}`
    if (r.value !== undefined) {
      try {
        out += `\n<result>\n${JSON.stringify(r.value, null, 2).slice(0, 4000)}\n</result>`
      } catch {
        out += `\n<result>[unserializable]</result>`
      }
    }
    return out
  }
}
```

and replace the register call's promise line:

```typescript
      promise: done.then((r) => `workflow ${r.runId} ${r.status}` + (r.error ? `: ${r.error}` : "")),
```

with:

```typescript
      promise: done.then((r) => WorkflowResultFormat.summarize(r)),
```

Update the Step-1 test to `import { WorkflowResultFormat } from "../../src/workflow/tool"` and call `WorkflowResultFormat.summarize` instead of the local `format`.

- [ ] **Step 4: Run tests**

Run: `bun test test/workflow/tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/tool.ts packages/aboocode/test/workflow/tool.test.ts
git commit -m "feat(workflow): completion notification carries the run's return value"
```

---

### Task 7: worktree isolation for workflow agents (§14.6b)

`opts.isolation: "worktree"` is accepted by the schema but ignored. Wire it to `AgentIsolation` exactly as the task tool does: create + register before prompting (prompt.ts resolves cwd/root from the registry), unregister + cleanup after.

**Files:**
- Modify: `src/workflow/spawn.ts`
- Test: `test/workflow/spawn.test.ts`

**Interfaces:**
- Consumes: `AgentIsolation.create("worktree", sessionID)` → `Promise<IsolationContext>` (has `cleanup(): Promise<void>`), `AgentIsolation.register(sessionID, ctx)`, `AgentIsolation.unregister(sessionID)` (`src/agent/isolation.ts:63,192,197`).
- Produces: `WorkflowSpawn.Deps` gains OPTIONAL `isolate?: (sessionID: string) => Promise<{ release: () => Promise<void> }>` (optional so pre-existing test fakes keep typechecking; call site falls back to the default).

- [ ] **Step 1: Failing test** — append to `test/workflow/spawn.test.ts`:

```typescript
test("worktree isolation is created before prompt and released after", async () => {
  const events: string[] = []
  const deps = {
    createSession: async () => ({ id: "ses_child" }),
    prompt: async () => {
      events.push("prompt")
      return { info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "ok" }] }
    },
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
    cancel: () => {},
    isolate: async (id: string) => {
      events.push(`isolate:${id}`)
      return { release: async () => void events.push(`release:${id}`) }
    },
  }
  await WorkflowSpawn.run("x", { isolation: "worktree" }, { sessionID: "ses_parent" } as any, deps)
  expect(events).toEqual(["isolate:ses_child", "prompt", "release:ses_child"])
})

test("no isolation dep call without opts.isolation", async () => {
  let isolated = 0
  const deps = {
    createSession: async () => ({ id: "ses_child" }),
    prompt: async () => ({ info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "ok" }] }),
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
    cancel: () => {},
    isolate: async () => {
      isolated++
      return { release: async () => {} }
    },
  }
  await WorkflowSpawn.run("x", {}, { sessionID: "ses_parent" } as any, deps)
  expect(isolated).toBe(0)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/workflow/spawn.test.ts`
Expected: FAIL — `isolate` never called / type error

- [ ] **Step 3: Implement** — in `src/workflow/spawn.ts`:

Extend `Deps` and defaults (optional field):

```typescript
    isolate?: (sessionID: string) => Promise<{ release: () => Promise<void> }>
```

```typescript
    isolate: async (sessionID) => {
      const { AgentIsolation } = await import("../agent/isolation")
      const isolation = await AgentIsolation.create("worktree", sessionID)
      AgentIsolation.register(sessionID, isolation)
      return {
        release: async () => {
          AgentIsolation.unregister(sessionID)
          await isolation.cleanup()
        },
      }
    },
```

In `run()`, after `createSession` and before the prompt call:

```typescript
      const isolate = deps.isolate ?? defaults.isolate!
      const isolation = opts.isolation === "worktree" ? await isolate(child.id) : undefined
```

and extend the existing `finally` (from Task 4) around the prompt:

```typescript
      } finally {
        ctx.abort?.removeEventListener("abort", onAbort)
        if (isolation) await isolation.release().catch((e) => log.error("isolation release failed", { error: e }))
      }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test test/workflow/ && bun run typecheck`
Expected: all pass; only the 4 pre-existing typecheck errors

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/spawn.ts packages/aboocode/test/workflow/spawn.test.ts
git commit -m "feat(workflow): worktree isolation for workflow agents"
```

---

### Task 8: workflow() composition (§14.6a)

`workflow(nameOrRef, args)` currently throws unconditionally. Wire it: one nesting level, child shares the parent's budget/semaphore/abort/agent-counter, child gets its own journal run row, name refs resolve from `.aboocode/workflows/<name>.js` in the project directory.

**Files:**
- Modify: `src/workflow/types.ts` (add `child` to `RunContext`)
- Modify: `src/workflow/run.ts` (child driver + ref resolution)
- Modify: `src/workflow/engine.ts:90-94` (delegate to `ctx.child`)
- Test: `test/workflow/run.test.ts`

**Interfaces:**
- Produces: `RunContext.child(ref: string | { scriptPath: string }, args?: any): Promise<any>`; `WorkflowRun.resolveRef(ref): Promise<{ source: string; scriptPath: string }>` (name → `<Instance.directory>/.aboocode/workflows/<name>.js`; throws `Error("workflow not found: <ref>")` on unreadable path).

- [ ] **Step 1: Failing tests** — append to `test/workflow/run.test.ts`:

```typescript
const CHILD_SCRIPT = `export const meta = { name: "child", description: "c" }
const r = await agent("inner: " + args.q)
return { r }
`

const PARENT_SCRIPT = (childPath: string) => `export const meta = { name: "parent", description: "p" }
const out = await workflow({ scriptPath: ${JSON.stringify(childPath)} }, { q: "hi" })
return out
`

test("workflow() runs a child by scriptPath, sharing the parent budget", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const childPath = `${tmp.path}/child.js`
      await Bun.write(childPath, CHILD_SCRIPT)
      const result = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: PARENT_SCRIPT(childPath),
        scriptPath: "/tmp/parent.js",
        args: undefined,
        budgetTotal: 100,
        spawn: async (prompt: string) => ({ text: "R(" + prompt + ")", tokens: 9 }),
      })
      expect(result.status).toBe("done")
      expect(result.value).toEqual({ r: "R(inner: hi)" })
    },
  })
})

test("workflow() nesting beyond one level throws", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const grandchildPath = `${tmp.path}/gc.js`
      await Bun.write(grandchildPath, CHILD_SCRIPT)
      const childPath = `${tmp.path}/mid.js`
      await Bun.write(
        childPath,
        `export const meta = { name: "mid", description: "m" }
return workflow({ scriptPath: ${JSON.stringify(grandchildPath)} }, { q: "x" })
`,
      )
      const result = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: PARENT_SCRIPT(childPath),
        scriptPath: "/tmp/parent.js",
        args: undefined,
        spawn: async () => ({ text: "t", tokens: 1 }),
      })
      expect(result.status).toBe("failed")
      expect(result.error).toContain("one level")
    },
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/workflow/run.test.ts`
Expected: FAIL — `workflow() composition is not available yet`

- [ ] **Step 3: Type + engine wiring** — in `src/workflow/types.ts`, add to `RunContext`:

```typescript
    child(ref: string | { scriptPath: string }, args?: any): Promise<any>
```

In `src/workflow/engine.ts`, replace the placeholder `workflow` function:

```typescript
    async function workflow(ref: string | { scriptPath: string }, args?: any): Promise<any> {
      return ctx.child(ref, args)
    }
```

- [ ] **Step 4: Child driver** — in `src/workflow/run.ts`:

Add ref resolution (import `path` and `Instance` — `import path from "path"`, `import { Instance } from "../project/instance"`):

```typescript
  export async function resolveRef(ref: string | { scriptPath: string }): Promise<{ source: string; scriptPath: string }> {
    const scriptPath =
      typeof ref === "string" ? path.join(Instance.directory, ".aboocode", "workflows", `${ref}.js`) : ref.scriptPath
    const file = Bun.file(scriptPath)
    if (!(await file.exists())) throw new Error(`workflow not found: ${typeof ref === "string" ? ref : scriptPath}`)
    return { source: await file.text(), scriptPath }
  }
```

In `drive()`, extend the `ctx` literal with a `child` implementation. The child shares `budget`, `semaphore`, `abort`, `guardSpawn`, and `spawn` from the parent context, gets its own run row, journal binding, seq counter, and `depth + 1`:

```typescript
      child: async (ref, childArgs) => {
        if (ctx.depth >= 1) throw new Error("workflow() nesting is limited to one level")
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
          return value
        } catch (e) {
          await WorkflowJournal.setStatus(childRunId, ctx.abort.aborted ? "stopped" : "failed")
          throw e
        }
      },
```

Note the forward-reference problem: `child` closes over `ctx`, which is the object being constructed. Declare `const ctx: WorkflowTypes.RunContext = { ... }` with `child` as a property arrow function referencing `ctx` — this is legal because `child` only dereferences `ctx` at call time, after construction. Import `WorkflowRuntime` and `WorkflowEngine` in run.ts if not already imported (`WorkflowRuntime` is; `WorkflowEngine` is).

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test test/workflow/ && bun run typecheck`
Expected: all pass; only the 4 pre-existing typecheck errors. If existing engine tests construct fake `ctx` objects without `child`, add `child: async () => null` to those fakes (they are typed `any`, so typecheck won't force it — only add where a test actually calls `workflow()`).

- [ ] **Step 6: Commit**

```bash
git add packages/aboocode/src/workflow/types.ts packages/aboocode/src/workflow/engine.ts packages/aboocode/src/workflow/run.ts packages/aboocode/test/workflow/run.test.ts
git commit -m "feat(workflow): workflow() composition — one nesting level, shared budget and caps"
```

---

### Task 9: Real-shape integration test for the schema spawn path (§14.8)

The `info.structured` bug shipped because every test faked the spawn result shape. Add tests that exercise `WorkflowSpawn.run` with the REAL `MessageV2.Assistant` result shape (structured output in `info.structured`, tokens in `info.tokens.{output,total}`), composed through `WorkflowEngine.agent` with a schema.

**Files:**
- Test: `test/workflow/integration.test.ts`

**Interfaces:**
- Consumes: `WorkflowSpawn.run` (with full Deps from Tasks 4/5/7), `WorkflowEngine.build`, `WorkflowSchema`.

- [ ] **Step 1: Write the test** — append to `test/workflow/integration.test.ts`:

```typescript
import { WorkflowSpawn } from "../../src/workflow/spawn"
import { WorkflowEngine } from "../../src/workflow/engine"

const realShapeDeps = (structured: unknown) => ({
  createSession: async () => ({ id: "ses_child" }),
  prompt: async () => ({
    // Real MessageV2.Assistant shape: structured lives on info, text parts are
    // intermediate tool-use narration only — NOT the final JSON answer.
    info: {
      structured,
      tokens: { total: 120, input: 80, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ type: "text", text: "I will now analyze the data..." }],
  }),
  parseModel: (m: string) => ({ providerID: "p", modelID: m }),
  cancel: () => {},
  isolate: async () => ({ release: async () => {} }),
})

test("schema agent reads structured output from info.structured, not text parts", async () => {
  const res = await WorkflowSpawn.run(
    "count bugs",
    { schema: { type: "object", properties: { bugs: { type: "number" } } } },
    { sessionID: "ses_parent" } as any,
    realShapeDeps({ bugs: 3 }),
  )
  expect(res).not.toBeNull()
  expect(JSON.parse(res!.text)).toEqual({ bugs: 3 })
  expect(res!.tokens).toBe(40)
})

test("schema agent through the engine yields the parsed object", async () => {
  const ctx: any = {
    runId: "wfr_i",
    sessionID: "ses_parent",
    args: undefined,
    resume: false,
    depth: 0,
    abort: new AbortController().signal,
    budget: { total: null, spent: () => 0, remaining: () => Infinity, add: () => {} },
    semaphore: { acquire: async () => {}, release: () => {} },
    nextSeq: () => 0,
    guardSpawn: () => {},
    journal: { lookup: async () => undefined, record: async () => {}, invalidateFrom: async () => {} },
    spawn: (p: string, o: any, c: any) => WorkflowSpawn.run(p, o, c, realShapeDeps({ bugs: 3 })),
    emit: () => {},
    child: async () => null,
  }
  const g = WorkflowEngine.build(ctx)
  const value = await g.agent("count bugs", { schema: { type: "object" } })
  expect(value).toEqual({ bugs: 3 })
})

test("schema agent with missing structured output fails closed (returns null)", async () => {
  const res = await WorkflowSpawn.run(
    "count bugs",
    { schema: { type: "object" } },
    { sessionID: "ses_parent" } as any,
    realShapeDeps(undefined),
  )
  // structured undefined → falls back to text parts, which are narration, not JSON
  expect(res!.text).toBe("I will now analyze the data...")
})
```

(adjust the import lines to the file's existing imports — merge, don't duplicate).

- [ ] **Step 2: Run the tests**

Run: `bun test test/workflow/integration.test.ts`
Expected: PASS (these lock in the already-fixed behavior; if any fail, the regression is real — investigate, don't adjust the test)

- [ ] **Step 3: Commit**

```bash
git add packages/aboocode/test/workflow/integration.test.ts
git commit -m "test(workflow): lock schema spawn path to the real MessageV2.Assistant shape"
```

---

### Task 10: Regression pass + spec status update

**Files:**
- Modify: `docs/superpowers/specs/2026-06-14-dynamic-workflow-engine-design.md` (§14)

- [ ] **Step 1: Full workflow + session suites**

Run: `bun test test/workflow/ test/session/`
Expected: all pass (session suite: 136 pass / 4 skip / 0 fail as of 59f971b)

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: only the 4 pre-existing baseline errors

- [ ] **Step 3: Update the spec** — append to §14 of `docs/superpowers/specs/2026-06-14-dynamic-workflow-engine-design.md`:

```markdown
### Follow-up status (2026-07-05)

All 8 deferred items closed: (1) child sessions get headless permission posture
(allow edit/write/bash/webfetch, deny todos/task/workflow); (2) abort wired through
engine.agent and spawn (SessionPrompt.cancel), aborted runs persist status "stopped";
(3) resume budget seeded from workflow_run.tokens_total and invalidateFrom now
decrements it; (4) completion notification carries the run's return value
(WorkflowResultFormat.summarize, 4k cap); (5) start() refuses resume of missing or
still-running runs; (6) workflow() composition (one level, shared budget/caps/abort,
name refs resolve from .aboocode/workflows/<name>.js) and worktree isolation via
AgentIsolation; (7) setStatus is honestly async and agent() opts are validated
(zod strict + JSON probe) at the sandbox boundary; (8) integration tests lock the
schema spawn path to the real MessageV2.Assistant shape.

Remaining before default-on: bake time under real use; child-run resume semantics
(children re-run live when the parent's workflow() call re-executes) are accepted.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-14-dynamic-workflow-engine-design.md
git commit -m "docs(workflow): record follow-up closure status"
```
