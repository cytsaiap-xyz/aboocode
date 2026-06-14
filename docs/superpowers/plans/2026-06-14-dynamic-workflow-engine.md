# Dynamic Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, resumable, in-process workflow runtime to aboocode plus a `Workflow` tool, so the model can orchestrate dozens–hundreds of subagents from a JS script it writes — executed outside the conversation, with only the final result returning to the session.

**Architecture:** A new `packages/aboocode/src/workflow/` subsystem. A `node:vm` runtime evaluates the model-authored script with curated globals (`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`workflow`/`args`) and determinism guards. `agent()` spawns a child session via the existing `SessionPrompt.prompt()`, throttled by a global semaphore and journaled to two new Drizzle tables for same-session resume. A `Workflow` tool launches runs in the background via the existing `BackgroundTasks` registry and streams progress over the existing bus/SSE path. Gated behind `experimental.workflows`.

**Tech Stack:** TypeScript, Bun, `node:vm`, Zod, Drizzle ORM (bun:sqlite), `bun:test`. Reuses `SessionPrompt`, `Session`, `AgentIsolation`, `Provider`, `Database`, `BusEvent`, `BackgroundTasks`, `Tool.define`.

---

## File Structure

| File | Responsibility |
| :--- | :--- |
| `src/workflow/types.ts` | Shared types: `AgentOpts`, `RunContext`, `Budget`, `JournalBinding`, `SpawnFn`, `WorkflowEvent`. Pure types only (no runtime deps), to avoid import cycles. |
| `src/workflow/concurrency.ts` | `WorkflowConcurrency.Semaphore` — async slot limiter capped at `min(16, cores-2)`. |
| `src/workflow/budget.ts` | `WorkflowBudget.create(total)` — token accounting view (`total`/`spent()`/`remaining()`/`add()`). |
| `src/workflow/runtime.ts` | `WorkflowRuntime` — parse `meta`, build the vm context with curated globals + determinism guards, evaluate the script body. |
| `src/workflow/schema.ts` | `WorkflowSchema` — build the `json_schema` output format and parse a schema-constrained result. |
| `src/workflow/journal.ts` | `WorkflowJournal` — Drizzle CRUD for runs + agent calls; `callKey`, `bind(runId)`, resume lookups. |
| `src/workflow/workflow.sql.ts` | Drizzle tables `WorkflowRunTable`, `WorkflowAgentCallTable`. |
| `src/workflow/spawn.ts` | `WorkflowSpawn.run` — one `agent()` call → child session via `SessionPrompt.prompt`. |
| `src/workflow/engine.ts` | `WorkflowEngine.build(ctx)` — the global functions handed to the script. |
| `src/workflow/events.ts` | `WorkflowEvents` — `BusEvent` definitions for progress streaming. |
| `src/workflow/run.ts` | `WorkflowRun` — run lifecycle: start (background), execute, status, stop. |
| `src/workflow/tool.ts` | `WorkflowTool` — the `Tool.define("workflow", …)` surface. |
| `src/workflow/tool.txt` | Tool description string. |
| `src/workflow/index.ts` | Barrel re-exports. |
| `src/storage/schema.ts` | **Modify**: export the two new tables. |
| `src/config/config.ts` | **Modify**: add `experimental.workflows` flag. |
| `src/tool/registry.ts` | **Modify**: register `WorkflowTool` behind the flag. |
| `migration/<ts>_add_workflow_tables/migration.sql` | New migration (auto-discovered by `storage/db.ts`). |
| `test/workflow/*.test.ts` | Tests, one file per module. |

**Shared interfaces (defined in Task 1, referenced everywhere):**

```typescript
// src/workflow/types.ts
export namespace WorkflowTypes {
  export interface AgentOpts {
    label?: string
    phase?: string
    schema?: Record<string, any> // JSON Schema
    model?: string // alias or full id
    isolation?: "worktree"
    agentType?: string
  }

  export interface Budget {
    total: number | null
    spent(): number
    remaining(): number
    add(tokens: number): void
  }

  export interface SpawnResult {
    text: string
    tokens: number
  }

  export type SpawnFn = (prompt: string, opts: AgentOpts, ctx: RunContext) => Promise<SpawnResult | null>

  export interface JournalEntry {
    seq: number
    callKey: string
    label?: string
    phase?: string
    prompt: string
    opts: AgentOpts
    result: any
    tokens: number
    status: "done" | "failed"
  }

  export interface JournalBinding {
    lookup(seq: number): Promise<{ callKey: string; result: any } | undefined>
    record(entry: JournalEntry): Promise<void>
    invalidateFrom(seq: number): Promise<void>
  }

  export type WorkflowEvent =
    | { kind: "phase"; runId: string; title: string }
    | { kind: "log"; runId: string; message: string }
    | { kind: "agent"; runId: string; seq: number; label?: string; phase?: string; status: "started" | "done" | "failed"; tokens?: number }

  export interface RunContext {
    runId: string
    sessionID: string
    model?: { providerID: string; modelID: string }
    args: any
    resume: boolean
    depth: number
    abort: AbortSignal
    budget: Budget
    semaphore: { acquire(): Promise<void>; release(): void }
    nextSeq(): number
    guardSpawn(): void
    journal: JournalBinding
    spawn: SpawnFn
    emit(ev: WorkflowEvent): void
  }
}
```

---

## Task 1: Shared types + concurrency semaphore

**Files:**
- Create: `packages/aboocode/src/workflow/types.ts`
- Create: `packages/aboocode/src/workflow/concurrency.ts`
- Test: `packages/aboocode/test/workflow/concurrency.test.ts`

- [ ] **Step 1: Write the types file** (no test — pure type declarations)

Create `src/workflow/types.ts` with the exact `WorkflowTypes` namespace shown in the **Shared interfaces** block above. Copy it verbatim.

- [ ] **Step 2: Write the failing test for the semaphore**

Create `test/workflow/concurrency.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowConcurrency } from "../../src/workflow/concurrency"

test("semaphore never exceeds its limit and runs everything", async () => {
  const sem = new WorkflowConcurrency.Semaphore(3)
  let active = 0
  let peak = 0
  let done = 0
  async function work() {
    await sem.acquire()
    try {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      done++
    } finally {
      sem.release()
    }
  }
  await Promise.all(Array.from({ length: 20 }, work))
  expect(peak).toBeLessThanOrEqual(3)
  expect(done).toBe(20)
})

test("create() caps at min(16, cores-2) and at least 1", () => {
  const sem = WorkflowConcurrency.create()
  expect(sem.limit).toBeGreaterThanOrEqual(1)
  expect(sem.limit).toBeLessThanOrEqual(16)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/concurrency.test.ts`
Expected: FAIL — `Cannot find module ".../workflow/concurrency"`.

- [ ] **Step 4: Write the semaphore**

Create `src/workflow/concurrency.ts`:

```typescript
import os from "os"

export namespace WorkflowConcurrency {
  export class Semaphore {
    readonly limit: number
    private active = 0
    private queue: (() => void)[] = []

    constructor(limit: number) {
      this.limit = Math.max(1, limit)
    }

    acquire(): Promise<void> {
      if (this.active < this.limit) {
        this.active++
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => this.queue.push(resolve))
    }

    release(): void {
      const next = this.queue.shift()
      if (next) {
        next()
        return
      }
      this.active = Math.max(0, this.active - 1)
    }
  }

  export function create(): Semaphore {
    const cores = os.cpus().length || 1
    return new Semaphore(Math.min(16, Math.max(1, cores - 2)))
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/concurrency.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/aboocode/src/workflow/types.ts packages/aboocode/src/workflow/concurrency.ts packages/aboocode/test/workflow/concurrency.test.ts
git commit -m "feat(workflow): shared types + concurrency semaphore"
```

---

## Task 2: Budget accounting

**Files:**
- Create: `packages/aboocode/src/workflow/budget.ts`
- Test: `packages/aboocode/test/workflow/budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/workflow/budget.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowBudget } from "../../src/workflow/budget"

test("null total means infinite remaining", () => {
  const b = WorkflowBudget.create(null)
  expect(b.total).toBeNull()
  b.add(1000)
  expect(b.spent()).toBe(1000)
  expect(b.remaining()).toBe(Infinity)
})

test("finite total tracks spend and clamps remaining at 0", () => {
  const b = WorkflowBudget.create(500)
  b.add(200)
  expect(b.remaining()).toBe(300)
  b.add(400)
  expect(b.spent()).toBe(600)
  expect(b.remaining()).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the budget**

Create `src/workflow/budget.ts`:

```typescript
import type { WorkflowTypes } from "./types"

export namespace WorkflowBudget {
  export function create(total: number | null): WorkflowTypes.Budget {
    let used = 0
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/budget.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/budget.ts packages/aboocode/test/workflow/budget.test.ts
git commit -m "feat(workflow): token budget accounting"
```

---

## Task 3: Runtime sandbox (vm + determinism guards)

**Files:**
- Create: `packages/aboocode/src/workflow/runtime.ts`
- Test: `packages/aboocode/test/workflow/runtime.test.ts`

The runtime parses the `export const meta = {…}` literal, then runs the rest of the script body as an async function inside a `node:vm` context whose only globals are the injected hooks + safe builtins. `Date.now`, `new Date()` (argless), and `Math.random` throw.

- [ ] **Step 1: Write the failing test**

Create `test/workflow/runtime.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowRuntime } from "../../src/workflow/runtime"

const META = `export const meta = { name: "t", description: "d", phases: [{ title: "P" }] }\n`

test("parseMeta extracts the literal", () => {
  const meta = WorkflowRuntime.parseMeta(META + "log('hi')")
  expect(meta.name).toBe("t")
  expect(meta.description).toBe("d")
  expect(meta.phases?.[0].title).toBe("P")
})

test("parseMeta throws when meta missing required fields", () => {
  expect(() => WorkflowRuntime.parseMeta(`export const meta = { name: "x" }\n`)).toThrow()
})

test("evaluate runs the body and returns its value, with globals injected", async () => {
  const calls: string[] = []
  const globals = {
    log: (m: string) => calls.push(m),
    agent: async (p: string) => "R:" + p,
  }
  const result = await WorkflowRuntime.evaluate(META + `log("a"); return await agent("x")`, globals)
  expect(calls).toEqual(["a"])
  expect(result).toBe("R:x")
})

test("determinism guards throw", async () => {
  await expect(WorkflowRuntime.evaluate(META + `return Date.now()`, {})).rejects.toThrow(/deterministic/i)
  await expect(WorkflowRuntime.evaluate(META + `return Math.random()`, {})).rejects.toThrow(/deterministic/i)
  await expect(WorkflowRuntime.evaluate(META + `return new Date().getTime()`, {})).rejects.toThrow(/deterministic/i)
})

test("host capabilities are absent from scope", async () => {
  await expect(WorkflowRuntime.evaluate(META + `return typeof require`, {})).resolves.toBe("undefined")
  await expect(WorkflowRuntime.evaluate(META + `return typeof process`, {})).resolves.toBe("undefined")
  await expect(WorkflowRuntime.evaluate(META + `return typeof fetch`, {})).resolves.toBe("undefined")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the runtime**

Create `src/workflow/runtime.ts`:

```typescript
import vm from "node:vm"
import z from "zod"

export namespace WorkflowRuntime {
  export const Meta = z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    whenToUse: z.string().optional(),
    model: z.string().optional(),
    phases: z
      .array(z.object({ title: z.string(), detail: z.string().optional(), model: z.string().optional() }))
      .optional(),
  })
  export type Meta = z.infer<typeof Meta>

  // Pull `export const meta = {…}` out of the source and evaluate just that literal
  // in an isolated context (no globals), then validate it.
  export function parseMeta(source: string): Meta {
    const match = source.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/m)
    if (!match) throw new Error("workflow script must start with `export const meta = { … }`")
    let raw: unknown
    try {
      raw = vm.runInNewContext("(" + match[1] + ")", Object.create(null), { timeout: 1000 })
    } catch (e) {
      throw new Error("workflow meta is not a valid object literal: " + (e as Error).message)
    }
    return Meta.parse(raw)
  }

  const GUARD_RANDOM = () => {
    throw new Error("Math.random() is not allowed in workflows (non-deterministic; breaks resume)")
  }

  function safeGlobals(injected: Record<string, unknown>): Record<string, unknown> {
    const mathProxy = new Proxy(Math, {
      get(target, prop) {
        if (prop === "random") return GUARD_RANDOM
        return (target as any)[prop]
      },
    })
    const DateGuard = function (this: unknown, ...args: unknown[]) {
      if (args.length === 0) throw new Error("new Date() with no args is not allowed in workflows (non-deterministic)")
      // @ts-expect-error spread into Date
      return new Date(...args)
    } as unknown as DateConstructor
    DateGuard.now = () => {
      throw new Error("Date.now() is not allowed in workflows (non-deterministic; breaks resume)")
    }
    return {
      JSON,
      Math: mathProxy,
      Date: DateGuard,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      Map,
      Set,
      RegExp,
      Error,
      Symbol,
      isNaN,
      isFinite,
      parseInt,
      parseFloat,
      structuredClone,
      console: { log: (...a: unknown[]) => void a },
      ...injected,
    }
  }

  // Strip the meta declaration, wrap the rest as an async function body, and run it
  // in a fresh vm context with only the safe globals visible.
  export async function evaluate(source: string, injected: Record<string, unknown>): Promise<any> {
    const body = source.replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}\s*;?/m, "")
    const context = vm.createContext(safeGlobals(injected))
    const wrapped = `(async () => {\n${body}\n})()`
    const script = new vm.Script(wrapped, { filename: "workflow.js" })
    return await script.runInContext(context)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/runtime.test.ts`
Expected: PASS (5 tests). If `vm.createContext` rejects awaiting a host promise under Bun, see the spec's risk note — fall back to `new Function(...Object.keys(globals))` invoked with the global values (still capability-limited because only those names are in scope); keep the same tests.

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/runtime.ts packages/aboocode/test/workflow/runtime.test.ts
git commit -m "feat(workflow): vm runtime with curated globals and determinism guards"
```

---

## Task 4: Structured-output schema helper

**Files:**
- Create: `packages/aboocode/src/workflow/schema.ts`
- Test: `packages/aboocode/test/workflow/schema.test.ts`

The child run is constrained with the existing `MessageV2` `json_schema` output format (which already retries on mismatch via `retryCount`), so by the time it returns the text is schema-valid JSON. This helper builds that format and parses the result.

- [ ] **Step 1: Write the failing test**

Create `test/workflow/schema.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowSchema } from "../../src/workflow/schema"

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }

test("toFormat builds a json_schema output format", () => {
  const f = WorkflowSchema.toFormat(SCHEMA)
  expect(f.type).toBe("json_schema")
  expect(f.schema).toEqual(SCHEMA)
  expect(f.retryCount).toBe(2)
})

test("parseResult parses fenced or raw JSON", () => {
  expect(WorkflowSchema.parseResult(`{"ok":true}`)).toEqual({ ok: true })
  expect(WorkflowSchema.parseResult("```json\n{\"ok\":false}\n```")).toEqual({ ok: false })
})

test("parseResult throws on non-JSON", () => {
  expect(() => WorkflowSchema.parseResult("not json")).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema helper**

Create `src/workflow/schema.ts`:

```typescript
import type { MessageV2 } from "../session/message-v2"

export namespace WorkflowSchema {
  export function toFormat(schema: Record<string, any>): MessageV2.OutputFormat {
    return { type: "json_schema", schema, retryCount: 2 }
  }

  // The json_schema format already validates against the schema with retries, so the
  // returned text should be conforming JSON. Strip an optional ```json fence and parse.
  export function parseResult(text: string): any {
    const trimmed = text.trim()
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
    const body = fenced ? fenced[1] : trimmed
    return JSON.parse(body)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/schema.ts packages/aboocode/test/workflow/schema.test.ts
git commit -m "feat(workflow): structured-output schema helper"
```

---

## Task 5: Journal — tables, migration, config flag (no logic yet)

**Files:**
- Create: `packages/aboocode/src/workflow/workflow.sql.ts`
- Modify: `packages/aboocode/src/storage/schema.ts`
- Modify: `packages/aboocode/src/config/config.ts:1226` (inside `experimental` object)
- Create: `packages/aboocode/migration/20260614120000_add_workflow_tables/migration.sql`
- Test: `packages/aboocode/test/workflow/schema-tables.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/workflow/schema-tables.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowRunTable, WorkflowAgentCallTable } from "../../src/workflow/workflow.sql"
import { getTableConfig } from "drizzle-orm/sqlite-core"

test("run table has expected columns", () => {
  const cols = getTableConfig(WorkflowRunTable).columns.map((c) => c.name)
  expect(cols).toEqual(
    expect.arrayContaining(["id", "session_id", "name", "script_path", "status", "args_json", "model", "tokens_total"]),
  )
})

test("agent_call table has expected columns", () => {
  const cols = getTableConfig(WorkflowAgentCallTable).columns.map((c) => c.name)
  expect(cols).toEqual(
    expect.arrayContaining(["id", "run_id", "seq", "call_key", "prompt", "opts_json", "result_json", "status", "tokens"]),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/schema-tables.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tables**

Create `src/workflow/workflow.sql.ts`:

```typescript
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    name: text().notNull(),
    script_path: text().notNull(),
    status: text().notNull(), // running | paused | done | failed | stopped
    args_json: text(),
    model: text(),
    tokens_total: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("workflow_run_session_idx").on(table.session_id)],
)

export const WorkflowAgentCallTable = sqliteTable(
  "workflow_agent_call",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    call_key: text().notNull(),
    label: text(),
    phase: text(),
    prompt: text().notNull(),
    opts_json: text(),
    result_json: text(),
    status: text().notNull(), // done | failed
    tokens: integer().notNull().default(0),
    time_started: integer().notNull(),
    time_ended: integer(),
  },
  (table) => [index("workflow_call_run_seq_idx").on(table.run_id, table.seq)],
)
```

- [ ] **Step 4: Export the tables from the schema barrel**

In `src/storage/schema.ts`, add at the end:

```typescript
export { WorkflowRunTable, WorkflowAgentCallTable } from "../workflow/workflow.sql"
```

- [ ] **Step 5: Add the config flag**

In `src/config/config.ts`, inside the `experimental` `z.object({ … })` (after the `batch_tool` line at ~1227), add:

```typescript
          workflows: z.boolean().optional().describe("Enable the dynamic Workflow tool (experimental)"),
```

- [ ] **Step 6: Write the migration**

Create `migration/20260614120000_add_workflow_tables/migration.sql` (auto-discovered by `storage/db.ts`'s `migrations()` directory scan):

```sql
CREATE TABLE `workflow_run` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`script_path` text NOT NULL,
	`status` text NOT NULL,
	`args_json` text,
	`model` text,
	`tokens_total` integer NOT NULL DEFAULT 0,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_agent_call` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`call_key` text NOT NULL,
	`label` text,
	`phase` text,
	`prompt` text NOT NULL,
	`opts_json` text,
	`result_json` text,
	`status` text NOT NULL,
	`tokens` integer NOT NULL DEFAULT 0,
	`time_started` integer NOT NULL,
	`time_ended` integer,
	CONSTRAINT `fk_workflow_call_run` FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workflow_run_session_idx` ON `workflow_run` (`session_id`);--> statement-breakpoint
CREATE INDEX `workflow_call_run_seq_idx` ON `workflow_agent_call` (`run_id`,`seq`);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/schema-tables.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Typecheck the config change**

Run: `cd packages/aboocode && bun run typecheck`
Expected: no new errors from `config.ts` / `schema.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/aboocode/src/workflow/workflow.sql.ts packages/aboocode/src/storage/schema.ts packages/aboocode/src/config/config.ts packages/aboocode/migration/20260614120000_add_workflow_tables/migration.sql packages/aboocode/test/workflow/schema-tables.test.ts
git commit -m "feat(workflow): journal tables, migration, experimental.workflows flag"
```

---

## Task 6: Journal logic (CRUD + callKey + resume binding)

**Files:**
- Create: `packages/aboocode/src/workflow/journal.ts`
- Test: `packages/aboocode/test/workflow/journal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/workflow/journal.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowJournal } from "../../src/workflow/journal"

test("callKey is stable for same inputs and differs when prompt changes", () => {
  const a = WorkflowJournal.callKey(0, "hello", { label: "x" })
  const b = WorkflowJournal.callKey(0, "hello", { label: "x" })
  const c = WorkflowJournal.callKey(0, "world", { label: "x" })
  expect(a).toBe(b)
  expect(a).not.toBe(c)
})

test("record, lookup, and invalidateFrom round-trip through the db", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const runId = await WorkflowJournal.createRun({
        sessionID: "ses_test",
        name: "t",
        scriptPath: "/tmp/s.js",
        model: "anthropic/claude",
        args: { a: 1 },
      })
      const j = WorkflowJournal.bind(runId)
      const key = WorkflowJournal.callKey(0, "p", {})
      await j.record({ seq: 0, callKey: key, prompt: "p", opts: {}, result: { ok: 1 }, tokens: 10, status: "done" })

      const hit = await j.lookup(0)
      expect(hit?.callKey).toBe(key)
      expect(hit?.result).toEqual({ ok: 1 })

      await j.record({ seq: 1, callKey: WorkflowJournal.callKey(1, "q", {}), prompt: "q", opts: {}, result: 2, tokens: 5, status: "done" })
      await j.invalidateFrom(1)
      expect(await j.lookup(1)).toBeUndefined()
      expect(await j.lookup(0)).toBeTruthy()

      const run = await WorkflowJournal.getRun(runId)
      expect(run?.tokens_total).toBe(15) // record() accumulates run tokens
    },
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/journal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the journal**

Create `src/workflow/journal.ts`:

```typescript
import { randomBytes, createHash } from "crypto"
import { eq, and, gte } from "drizzle-orm"
import { Database } from "@/storage/db"
import { WorkflowRunTable, WorkflowAgentCallTable } from "./workflow.sql"
import type { WorkflowTypes } from "./types"

export namespace WorkflowJournal {
  export type Status = "running" | "paused" | "done" | "failed" | "stopped"

  function id(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`
  }

  function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((value as any)[k])).join(",") + "}"
  }

  export function callKey(seq: number, prompt: string, opts: WorkflowTypes.AgentOpts): string {
    return createHash("sha256").update(`${seq} ${prompt} ${canonical(opts)}`).digest("hex")
  }

  export async function createRun(input: {
    sessionID: string
    name: string
    scriptPath: string
    model?: string
    args: unknown
  }): Promise<string> {
    const runId = id("wfr")
    Database.use((db) =>
      db
        .insert(WorkflowRunTable)
        .values({
          id: runId,
          session_id: input.sessionID,
          name: input.name,
          script_path: input.scriptPath,
          status: "running",
          args_json: input.args === undefined ? null : JSON.stringify(input.args),
          model: input.model ?? null,
        })
        .run(),
    )
    return runId
  }

  export function setStatus(runId: string, status: Status): void {
    Database.use((db) => db.update(WorkflowRunTable).set({ status }).where(eq(WorkflowRunTable.id, runId)).run())
  }

  export async function getRun(runId: string) {
    return Database.use((db) => db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runId)).all()[0])
  }

  export function bind(runId: string): WorkflowTypes.JournalBinding {
    return {
      async lookup(seq) {
        const row = Database.use((db) =>
          db
            .select()
            .from(WorkflowAgentCallTable)
            .where(and(eq(WorkflowAgentCallTable.run_id, runId), eq(WorkflowAgentCallTable.seq, seq)))
            .all()[0],
        )
        if (!row) return undefined
        return { callKey: row.call_key, result: row.result_json === null ? null : JSON.parse(row.result_json) }
      },
      async record(entry) {
        Database.transaction((db) => {
          db.insert(WorkflowAgentCallTable)
            .values({
              id: id("wfc"),
              run_id: runId,
              seq: entry.seq,
              call_key: entry.callKey,
              label: entry.label ?? null,
              phase: entry.phase ?? null,
              prompt: entry.prompt,
              opts_json: JSON.stringify(entry.opts),
              result_json: entry.result === undefined ? null : JSON.stringify(entry.result),
              status: entry.status,
              tokens: entry.tokens,
              time_started: Date.now(),
              time_ended: Date.now(),
            })
            .run()
          const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runId)).all()[0]
          db.update(WorkflowRunTable)
            .set({ tokens_total: (run?.tokens_total ?? 0) + entry.tokens })
            .where(eq(WorkflowRunTable.id, runId))
            .run()
        })
      },
      async invalidateFrom(seq) {
        Database.use((db) =>
          db
            .delete(WorkflowAgentCallTable)
            .where(and(eq(WorkflowAgentCallTable.run_id, runId), gte(WorkflowAgentCallTable.seq, seq)))
            .run(),
        )
      },
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/journal.test.ts`
Expected: PASS (2 tests). The migration from Task 5 applies automatically when `Database.Client()` first opens inside `Instance.provide`.

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/journal.ts packages/aboocode/test/workflow/journal.test.ts
git commit -m "feat(workflow): journal CRUD + callKey + resume binding"
```

---

## Task 7: Engine (agent/parallel/pipeline/phase/log/budget globals)

**Files:**
- Create: `packages/aboocode/src/workflow/engine.ts`
- Test: `packages/aboocode/test/workflow/engine.test.ts`

`WorkflowEngine.build(ctx)` returns the globals object handed to the runtime. All spawning is injected via `ctx.spawn`, so this is unit-tested with a fake spawn (no real models).

- [ ] **Step 1: Write the failing test**

Create `test/workflow/engine.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowEngine } from "../../src/workflow/engine"
import { WorkflowConcurrency } from "../../src/workflow/concurrency"
import { WorkflowBudget } from "../../src/workflow/budget"
import type { WorkflowTypes } from "../../src/workflow/types"

function fakeCtx(spawn: WorkflowTypes.SpawnFn, over: Partial<WorkflowTypes.RunContext> = {}): WorkflowTypes.RunContext {
  let seq = 0
  let spawned = 0
  const store = new Map<number, { callKey: string; result: any }>()
  return {
    runId: "wfr_test",
    sessionID: "ses",
    model: undefined,
    args: undefined,
    resume: false,
    depth: 0,
    abort: new AbortController().signal,
    budget: WorkflowBudget.create(null),
    semaphore: new WorkflowConcurrency.Semaphore(4),
    nextSeq: () => seq++,
    guardSpawn: () => {
      spawned++
      if (spawned > 1000) throw new Error("workflow exceeded 1000 agents")
    },
    journal: {
      async lookup(s) {
        return store.get(s)
      },
      async record(e) {
        store.set(e.seq, { callKey: e.callKey, result: e.result })
      },
      async invalidateFrom() {},
    },
    spawn,
    emit: () => {},
    ...over,
  }
}

test("agent returns text and records the call", async () => {
  const g = WorkflowEngine.build(fakeCtx(async (p) => ({ text: "got:" + p, tokens: 3 })))
  expect(await g.agent("hi")).toBe("got:hi")
})

test("agent with schema returns a parsed object", async () => {
  const g = WorkflowEngine.build(fakeCtx(async () => ({ text: `{"n":7}`, tokens: 1 })))
  expect(await g.agent("x", { schema: { type: "object" } })).toEqual({ n: 7 })
})

test("agent returns null on spawn failure (so scripts can filter)", async () => {
  const g = WorkflowEngine.build(fakeCtx(async () => null))
  expect(await g.agent("x")).toBeNull()
})

test("parallel is a barrier and maps thrown thunks to null", async () => {
  const g = WorkflowEngine.build(fakeCtx(async (p) => ({ text: p, tokens: 0 })))
  const out = await g.parallel([() => g.agent("a"), async () => { throw new Error("boom") }, () => g.agent("c")])
  expect(out).toEqual(["a", null, "c"])
})

test("pipeline runs stages per-item with no inter-stage barrier", async () => {
  const g = WorkflowEngine.build(fakeCtx(async (p) => ({ text: p, tokens: 0 })))
  const order: string[] = []
  const out = await g.pipeline(
    ["A", "B"],
    async (item: string) => {
      order.push("s1:" + item)
      if (item === "A") await new Promise((r) => setTimeout(r, 20)) // A is slow in stage 1
      return item
    },
    async (prev: string) => {
      order.push("s2:" + prev)
      return prev.toLowerCase()
    },
  )
  expect(out).toEqual(["a", "b"])
  // B reaches stage 2 before A finishes stage 1 → no barrier
  expect(order.indexOf("s2:B")).toBeLessThan(order.indexOf("s2:A"))
})

test("budget ceiling makes agent throw once exhausted", async () => {
  const ctx = fakeCtx(async () => ({ text: "x", tokens: 100 }), { budget: WorkflowBudget.create(50) })
  ctx.budget.add(50)
  const g = WorkflowEngine.build(ctx)
  await expect(g.agent("x")).rejects.toThrow(/budget/i)
})

test("resume returns cached result without spawning", async () => {
  let spawnCount = 0
  const ctx = fakeCtx(async (p) => {
    spawnCount++
    return { text: "live:" + p, tokens: 0 }
  })
  // seed the journal as if a prior run completed seq 0
  await ctx.journal.record({ seq: 0, callKey: (await import("../../src/workflow/journal")).WorkflowJournal.callKey(0, "p", {}), prompt: "p", opts: {}, result: "cached", tokens: 0, status: "done" })
  const resumeCtx = { ...ctx, resume: true, nextSeq: (() => { let s = 0; return () => s++ })() }
  const g = WorkflowEngine.build(resumeCtx)
  expect(await g.agent("p")).toBe("cached")
  expect(spawnCount).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the engine**

Create `src/workflow/engine.ts`:

```typescript
import type { WorkflowTypes } from "./types"
import { WorkflowSchema } from "./schema"
import { WorkflowJournal } from "./journal"

export namespace WorkflowEngine {
  const MAX_ITEMS = 4096

  export function build(ctx: WorkflowTypes.RunContext) {
    let currentPhase: string | undefined

    async function agent(prompt: string, opts: WorkflowTypes.AgentOpts = {}): Promise<any> {
      const seq = ctx.nextSeq()
      const phase = opts.phase ?? currentPhase
      const callKey = WorkflowJournal.callKey(seq, prompt, opts)

      if (ctx.resume) {
        const cached = await ctx.journal.lookup(seq)
        if (cached && cached.callKey === callKey) return cached.result
        if (cached) await ctx.journal.invalidateFrom(seq)
      }

      if (ctx.budget.total !== null && ctx.budget.remaining() <= 0)
        throw new Error("workflow budget exceeded")
      ctx.guardSpawn()

      await ctx.semaphore.acquire()
      ctx.emit({ kind: "agent", runId: ctx.runId, seq, label: opts.label, phase, status: "started" })
      try {
        const res = await ctx.spawn(prompt, opts, ctx)
        if (!res) {
          await ctx.journal.record({ seq, callKey, label: opts.label, phase, prompt, opts, result: null, tokens: 0, status: "failed" })
          ctx.emit({ kind: "agent", runId: ctx.runId, seq, label: opts.label, phase, status: "failed" })
          return null
        }
        let value: any = res.text
        if (opts.schema) {
          try {
            value = WorkflowSchema.parseResult(res.text)
          } catch {
            await ctx.journal.record({ seq, callKey, label: opts.label, phase, prompt, opts, result: null, tokens: res.tokens, status: "failed" })
            ctx.emit({ kind: "agent", runId: ctx.runId, seq, label: opts.label, phase, status: "failed", tokens: res.tokens })
            return null
          }
        }
        ctx.budget.add(res.tokens)
        await ctx.journal.record({ seq, callKey, label: opts.label, phase, prompt, opts, result: value, tokens: res.tokens, status: "done" })
        ctx.emit({ kind: "agent", runId: ctx.runId, seq, label: opts.label, phase, status: "done", tokens: res.tokens })
        return value
      } finally {
        ctx.semaphore.release()
      }
    }

    async function parallel(thunks: Array<() => Promise<any>>): Promise<any[]> {
      if (thunks.length > MAX_ITEMS) throw new Error(`parallel() accepts at most ${MAX_ITEMS} items`)
      return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
    }

    async function pipeline(items: any[], ...stages: Array<(prev: any, item: any, index: number) => Promise<any>>): Promise<any[]> {
      if (items.length > MAX_ITEMS) throw new Error(`pipeline() accepts at most ${MAX_ITEMS} items`)
      return Promise.all(
        items.map(async (item, index) => {
          let acc = item
          for (const stage of stages) {
            try {
              acc = await stage(acc, item, index)
            } catch {
              return null
            }
          }
          return acc
        }),
      )
    }

    function phase(title: string): void {
      currentPhase = title
      ctx.emit({ kind: "phase", runId: ctx.runId, title })
    }

    function log(message: string): void {
      ctx.emit({ kind: "log", runId: ctx.runId, message })
    }

    // workflow() composition is wired in Task 8 (needs the run loader); placeholder that
    // errors keeps the global present and the contract explicit until then.
    async function workflow(): Promise<any> {
      throw new Error("workflow() composition is not available yet")
    }

    return { agent, parallel, pipeline, phase, log, workflow, budget: ctx.budget, args: ctx.args }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/engine.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/engine.ts packages/aboocode/test/workflow/engine.test.ts
git commit -m "feat(workflow): orchestration engine (agent/parallel/pipeline/phase/log)"
```

---

## Task 8: Spawn (agent() → child session)

**Files:**
- Create: `packages/aboocode/src/workflow/spawn.ts`
- Test: `packages/aboocode/test/workflow/spawn.test.ts`

`WorkflowSpawn.run` is the only unit that talks to `SessionPrompt`. It is written so the prompt function and session factory are injectable for testing.

- [ ] **Step 1: Write the failing test**

Create `test/workflow/spawn.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowSpawn } from "../../src/workflow/spawn"

test("run creates a child session, prompts, and extracts final text + tokens", async () => {
  const calls: any[] = []
  const deps = {
    createSession: async (input: any) => {
      calls.push(["create", input])
      return { id: "ses_child" }
    },
    prompt: async (input: any) => {
      calls.push(["prompt", input])
      return {
        info: { tokens: { output: 42 } },
        parts: [{ type: "text", text: "hello world" }],
      }
    },
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
  }
  const ctx: any = { sessionID: "ses_parent", model: { providerID: "p", modelID: "base" } }
  const res = await WorkflowSpawn.run("do it", { agentType: "general", model: "sonnet" }, ctx, deps)
  expect(res).toEqual({ text: "hello world", tokens: 42 })
  // child session parented to the run's session
  expect(calls[0][1].parentID).toBe("ses_parent")
  // model override resolved via parseModel
  expect(calls[1][1].model).toEqual({ providerID: "p", modelID: "sonnet" })
  expect(calls[1][1].agent).toBe("general")
})

test("run returns null when the prompt throws", async () => {
  const deps = {
    createSession: async () => ({ id: "ses_child" }),
    prompt: async () => {
      throw new Error("model error")
    },
    parseModel: (m: string) => ({ providerID: "p", modelID: m }),
  }
  const ctx: any = { sessionID: "ses_parent" }
  expect(await WorkflowSpawn.run("x", {}, ctx, deps)).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/spawn.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the spawn module**

Create `src/workflow/spawn.ts`:

```typescript
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Provider } from "../provider/provider"
import { WorkflowSchema } from "./schema"
import type { WorkflowTypes } from "./types"

export namespace WorkflowSpawn {
  export interface Deps {
    createSession: (input: { parentID: string; title: string }) => Promise<{ id: string }>
    prompt: (input: any) => Promise<{ info: any; parts: any[] }>
    parseModel: (m: string) => { providerID: string; modelID: string }
  }

  const defaults: Deps = {
    createSession: (input) => Session.create(input as any) as any,
    prompt: (input) => SessionPrompt.prompt(input),
    parseModel: (m) => Provider.parseModel(m),
  }

  export async function run(
    prompt: string,
    opts: WorkflowTypes.AgentOpts,
    ctx: Pick<WorkflowTypes.RunContext, "sessionID" | "model">,
    deps: Deps = defaults,
  ): Promise<WorkflowTypes.SpawnResult | null> {
    try {
      const child = await deps.createSession({
        parentID: ctx.sessionID,
        title: opts.label ?? "workflow agent",
      })
      const model = opts.model ? deps.parseModel(opts.model) : ctx.model
      const result = await deps.prompt({
        sessionID: child.id,
        agent: opts.agentType ?? "general",
        model,
        parts: [{ type: "text", text: prompt }],
        ...(opts.schema ? { format: WorkflowSchema.toFormat(opts.schema) } : {}),
      })
      const text = (result.parts.findLast((p: any) => p.type === "text") as any)?.text ?? ""
      const tokens = result.info?.tokens?.output ?? result.info?.tokens?.total ?? 0
      return { text, tokens }
    } catch {
      return null
    }
  }
}
```

> Note on `isolation: "worktree"`: thread `opts.isolation` into `createSession`/`AgentIsolation.create` here. It is omitted from the v1 happy path because the default (shared) isolation needs no setup; wire it when worktree-mutation workflows are exercised. Confirm `result.info.tokens` shape against `session/message-v2.ts` `Info` during implementation; adjust the `tokens` accessor if the field differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/spawn.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/spawn.ts packages/aboocode/test/workflow/spawn.test.ts
git commit -m "feat(workflow): agent() spawn via SessionPrompt"
```

---

## Task 9: Bus events for progress

**Files:**
- Create: `packages/aboocode/src/workflow/events.ts`
- Test: `packages/aboocode/test/workflow/events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/workflow/events.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { WorkflowEvents } from "../../src/workflow/events"

test("event definitions exist with correct types", () => {
  expect(WorkflowEvents.Started.type).toBe("workflow.started")
  expect(WorkflowEvents.Progress.type).toBe("workflow.progress")
  expect(WorkflowEvents.Completed.type).toBe("workflow.completed")
  // schema accepts a representative payload
  expect(() => WorkflowEvents.Progress.properties.parse({ runId: "r", kind: "log", message: "hi" })).not.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the events**

Create `src/workflow/events.ts`:

```typescript
import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace WorkflowEvents {
  export const Started = BusEvent.define(
    "workflow.started",
    z.object({ runId: z.string(), sessionID: z.string(), name: z.string() }),
  )

  export const Progress = BusEvent.define(
    "workflow.progress",
    z.object({
      runId: z.string(),
      kind: z.enum(["phase", "log", "agent"]),
      title: z.string().optional(),
      message: z.string().optional(),
      seq: z.number().optional(),
      label: z.string().optional(),
      phase: z.string().optional(),
      status: z.enum(["started", "done", "failed"]).optional(),
      tokens: z.number().optional(),
    }),
  )

  export const Completed = BusEvent.define(
    "workflow.completed",
    z.object({ runId: z.string(), status: z.enum(["done", "failed", "stopped"]), tokens: z.number() }),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/events.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/events.ts packages/aboocode/test/workflow/events.test.ts
git commit -m "feat(workflow): bus events for progress streaming"
```

---

## Task 10: Run lifecycle (wire runtime + engine + journal + spawn + events)

**Files:**
- Create: `packages/aboocode/src/workflow/run.ts`
- Test: `packages/aboocode/test/workflow/run.test.ts`

`WorkflowRun.execute` builds a `RunContext`, runs the script through the runtime, and finalizes status. It accepts an injectable `spawn` so the integration test can use a fake; the `start` entry uses the real `WorkflowSpawn.run`.

- [ ] **Step 1: Write the failing test**

Create `test/workflow/run.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowRun } from "../../src/workflow/run"
import { WorkflowJournal } from "../../src/workflow/journal"

const SCRIPT = `export const meta = { name: "demo", description: "d", phases: [{ title: "Work" }] }
phase("Work")
const a = await agent("one")
const b = await agent("two")
return { a, b }
`

test("execute runs a script end-to-end and journals each agent call", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let n = 0
      const result = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: SCRIPT,
        scriptPath: "/tmp/demo.js",
        args: undefined,
        spawn: async (prompt: string) => ({ text: "R(" + prompt + ")#" + n++, tokens: 2 }),
      })
      expect(result.status).toBe("done")
      expect(result.value).toEqual({ a: "R(one)#0", b: "R(two)#1" })

      const run = await WorkflowJournal.getRun(result.runId)
      expect(run?.status).toBe("done")
      expect(run?.tokens_total).toBe(4)
    },
  })
})

test("resume replays cached calls without re-spawning", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let spawnCount = 0
      const first = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: SCRIPT,
        scriptPath: "/tmp/demo.js",
        args: undefined,
        spawn: async (prompt: string) => {
          spawnCount++
          return { text: "R(" + prompt + ")", tokens: 1 }
        },
      })
      const before = spawnCount
      const resumed = await WorkflowRun.execute({
        sessionID: "ses_demo",
        source: SCRIPT,
        scriptPath: "/tmp/demo.js",
        args: undefined,
        resumeFromRunId: first.runId,
        spawn: async (prompt: string) => {
          spawnCount++
          return { text: "LIVE(" + prompt + ")", tokens: 1 }
        },
      })
      expect(resumed.status).toBe("done")
      expect(resumed.value).toEqual(first.value) // cached, not LIVE(...)
      expect(spawnCount).toBe(before) // no new spawns on a clean resume
    },
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the run module**

Create `src/workflow/run.ts`:

```typescript
import { Bus } from "../bus"
import { WorkflowRuntime } from "./runtime"
import { WorkflowEngine } from "./engine"
import { WorkflowJournal } from "./journal"
import { WorkflowBudget } from "./budget"
import { WorkflowConcurrency } from "./concurrency"
import { WorkflowSpawn } from "./spawn"
import { WorkflowEvents } from "./events"
import type { WorkflowTypes } from "./types"

export namespace WorkflowRun {
  const MAX_AGENTS = 1000

  export interface ExecuteInput {
    sessionID: string
    source: string
    scriptPath: string
    args: unknown
    model?: { providerID: string; modelID: string }
    budgetTotal?: number | null
    resumeFromRunId?: string
    spawn?: WorkflowTypes.SpawnFn
    abort?: AbortSignal
  }

  export interface ExecuteResult {
    runId: string
    status: WorkflowJournal.Status
    value?: any
    error?: string
  }

  export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
    const meta = WorkflowRuntime.parseMeta(input.source)

    const runId =
      input.resumeFromRunId ??
      (await WorkflowJournal.createRun({
        sessionID: input.sessionID,
        name: meta.name,
        scriptPath: input.scriptPath,
        model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
        args: input.args,
      }))

    if (input.resumeFromRunId) WorkflowJournal.setStatus(runId, "running")

    Bus.publish(WorkflowEvents.Started, { runId, sessionID: input.sessionID, name: meta.name })

    let seq = 0
    let spawned = 0
    const spawnFn = input.spawn ?? ((p, o, c) => WorkflowSpawn.run(p, o, c))

    const ctx: WorkflowTypes.RunContext = {
      runId,
      sessionID: input.sessionID,
      model: input.model,
      args: input.args,
      resume: Boolean(input.resumeFromRunId),
      depth: 0,
      abort: input.abort ?? new AbortController().signal,
      budget: WorkflowBudget.create(input.budgetTotal ?? null),
      semaphore: WorkflowConcurrency.create(),
      nextSeq: () => seq++,
      guardSpawn: () => {
        spawned++
        if (spawned > MAX_AGENTS) throw new Error(`workflow exceeded ${MAX_AGENTS} agents`)
      },
      journal: WorkflowJournal.bind(runId),
      spawn: spawnFn,
      emit: (ev) =>
        Bus.publish(WorkflowEvents.Progress, {
          runId,
          kind: ev.kind,
          title: "title" in ev ? ev.title : undefined,
          message: "message" in ev ? ev.message : undefined,
          seq: "seq" in ev ? ev.seq : undefined,
          label: "label" in ev ? ev.label : undefined,
          phase: "phase" in ev ? ev.phase : undefined,
          status: "status" in ev ? ev.status : undefined,
          tokens: "tokens" in ev ? ev.tokens : undefined,
        }),
    }

    const globals = WorkflowEngine.build(ctx)
    try {
      const value = await WorkflowRuntime.evaluate(input.source, globals as any)
      WorkflowJournal.setStatus(runId, "done")
      const run = await WorkflowJournal.getRun(runId)
      Bus.publish(WorkflowEvents.Completed, { runId, status: "done", tokens: run?.tokens_total ?? 0 })
      return { runId, status: "done", value }
    } catch (e) {
      const error = (e as Error).message
      WorkflowJournal.setStatus(runId, "failed")
      const run = await WorkflowJournal.getRun(runId)
      Bus.publish(WorkflowEvents.Completed, { runId, status: "failed", tokens: run?.tokens_total ?? 0 })
      return { runId, status: "failed", error }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/aboocode && bun test test/workflow/run.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aboocode/src/workflow/run.ts packages/aboocode/test/workflow/run.test.ts
git commit -m "feat(workflow): run lifecycle wiring runtime+engine+journal+events"
```

---

## Task 11: The `Workflow` tool + barrel + registration

**Files:**
- Create: `packages/aboocode/src/workflow/tool.ts`
- Create: `packages/aboocode/src/workflow/tool.txt`
- Create: `packages/aboocode/src/workflow/index.ts`
- Modify: `packages/aboocode/src/tool/registry.ts`
- Test: `packages/aboocode/test/workflow/tool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/workflow/tool.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowTool } from "../../src/workflow/tool"

const SCRIPT = `export const meta = { name: "demo", description: "d" }
return await agent("hi")
`

function ctx(): any {
  return {
    sessionID: "ses_tool",
    messageID: "msg_1",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

test("workflow tool validates meta and returns a runId + scriptPath", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await WorkflowTool.init()
      const res = await tool.execute({ script: SCRIPT }, ctx())
      expect(res.metadata.runId).toMatch(/^wfr_/)
      expect(res.metadata.scriptPath).toBeTruthy()
      expect(res.output).toContain(res.metadata.runId)
    },
  })
})

test("workflow tool rejects a script with no meta", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await WorkflowTool.init()
      await expect(tool.execute({ script: `return 1` }, ctx())).rejects.toThrow(/meta/i)
    },
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aboocode && bun test test/workflow/tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool description**

Create `src/workflow/tool.txt`:

```
Launch a dynamic workflow: a JavaScript script that orchestrates many subagents deterministically. The runtime executes the script in the background while the session stays responsive; only the final result returns to the conversation.

The script must begin with `export const meta = { name, description, phases? }` followed by an async body using the globals: agent(prompt, opts?) -> Promise (opts: label, phase, schema, model, isolation, agentType); parallel(thunks) (barrier); pipeline(items, ...stages) (no inter-stage barrier); phase(title); log(message); args; budget; workflow(ref, args).

Date.now(), new Date() with no args, and Math.random() are unavailable (they break resume). Returns { runId, scriptPath }. Resume a prior run with resumeFromRunId.
```

- [ ] **Step 4: Write the tool**

Create `src/workflow/tool.ts`:

```typescript
import z from "zod"
import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { randomBytes } from "crypto"
import { Tool } from "../tool/tool"
import { Global } from "../global"
import { WorkflowRuntime } from "./runtime"
import { WorkflowRun } from "./run"
import { BackgroundTasks } from "../session/background"
import DESCRIPTION from "./tool.txt"

export const WorkflowTool = Tool.define("workflow", {
  description: DESCRIPTION,
  parameters: z.object({
    script: z.string().optional().describe("Inline workflow script beginning with `export const meta = {…}`"),
    scriptPath: z.string().optional().describe("Path to a workflow script file (takes precedence over script)"),
    args: z.any().optional().describe("JSON value exposed to the script as the global `args`"),
    resumeFromRunId: z.string().optional().describe("Resume a prior run in this session"),
  }),
  async execute(params, ctx) {
    const source = params.scriptPath ? await Bun.file(params.scriptPath).text() : params.script
    if (!source) throw new Error("workflow requires either `script` or `scriptPath`")

    // Validate meta up front so a bad script fails fast before any run row is created.
    const meta = WorkflowRuntime.parseMeta(source)

    await ctx.ask({
      permission: "workflow",
      patterns: [meta.name],
      always: ["*"],
      metadata: { name: meta.name, phases: (meta.phases ?? []).map((p) => p.title) },
    })

    const dir = path.join(Global.Path.data, "workflows", ctx.sessionID)
    await mkdir(dir, { recursive: true })
    const scriptPath = params.scriptPath ?? path.join(dir, `wf_${Date.now().toString(36)}${randomBytes(3).toString("hex")}.js`)
    if (!params.scriptPath) await writeFile(scriptPath, source, "utf-8")

    // Kick off in the background; return immediately with the runId.
    const runPromise = WorkflowRun.execute({
      sessionID: ctx.sessionID,
      source,
      scriptPath,
      args: params.args,
      resumeFromRunId: params.resumeFromRunId,
      abort: ctx.abort,
    }).then((r) => `workflow ${r.runId} ${r.status}` + (r.error ? `: ${r.error}` : ""))

    // We need the runId synchronously for the tool result; createRun is the first await
    // inside execute(). To surface it immediately, start execute() and read its runId from
    // the resolved value's prefix is not possible — instead, run() returns the id via the
    // background registry keyed by a freshly minted handle:
    const handle = `wf_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`
    BackgroundTasks.register({
      taskID: handle,
      sessionID: ctx.sessionID,
      parentSessionID: ctx.sessionID,
      description: `workflow: ${meta.name}`,
      agentType: "workflow",
      promise: runPromise,
    })

    return {
      title: `Workflow ${meta.name} started`,
      output: [`Started workflow "${meta.name}" (handle ${handle}).`, `script: ${scriptPath}`, `Progress streams via workflow.* events; the result returns when it finishes.`].join("\n"),
      metadata: { runId: handle, scriptPath, name: meta.name },
    }
  },
})
```

> Implementation note: the tool returns the background **handle** as `runId` in metadata for immediate response. If you need the *journal* runId synchronously, refactor `WorkflowRun.execute` to split `createRun` into a `WorkflowRun.start(input): { runId; done: Promise<ExecuteResult> }` that creates the row synchronously-ish (await the insert) and returns both the id and the completion promise; then register `done` with `BackgroundTasks` and return the real `runId`. The test asserts `metadata.runId` matches `/^wfr_/` **only if** you take the `start()` refactor — otherwise change the test to match the handle prefix `/^wf_/`. Choose the `start()` refactor for fidelity; update `run.test.ts` is not required since `execute` stays.

- [ ] **Step 5: Adjust the test to the chosen runId source**

If you took the `start()` refactor (recommended), keep the `/^wfr_/` assertion. If you returned the handle, change that assertion to `expect(res.metadata.runId).toMatch(/^wf_/)`. Pick one and make the test match.

- [ ] **Step 6: Write the barrel**

Create `src/workflow/index.ts`:

```typescript
export { WorkflowTool } from "./tool"
export { WorkflowRun } from "./run"
export { WorkflowJournal } from "./journal"
export { WorkflowEvents } from "./events"
```

- [ ] **Step 7: Register the tool behind the flag**

In `src/tool/registry.ts`, add the import near the other tool imports (after line 34's `CronCreateTool` import):

```typescript
import { WorkflowTool } from "../workflow/tool"
```

Then inside the `all()` tool array (right after `VerifyTool,` at ~line 196), add:

```typescript
      ...(config.experimental?.workflows === true ? [WorkflowTool] : []),
```

- [ ] **Step 8: Run the tool test**

Run: `cd packages/aboocode && bun test test/workflow/tool.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Typecheck**

Run: `cd packages/aboocode && bun run typecheck`
Expected: no new errors.

- [ ] **Step 10: Commit**

```bash
git add packages/aboocode/src/workflow/tool.ts packages/aboocode/src/workflow/tool.txt packages/aboocode/src/workflow/index.ts packages/aboocode/src/tool/registry.ts packages/aboocode/test/workflow/tool.test.ts
git commit -m "feat(workflow): Workflow tool + registration behind experimental.workflows"
```

---

## Task 12: Integration test (run → journal → resume → events)

**Files:**
- Test: `packages/aboocode/test/workflow/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/workflow/integration.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { WorkflowRun } from "../../src/workflow/run"
import { WorkflowJournal } from "../../src/workflow/journal"
import { WorkflowEvents } from "../../src/workflow/events"
import { Bus } from "../../src/bus"

const SCRIPT = `export const meta = { name: "audit", description: "two-phase demo", phases: [{ title: "Find" }, { title: "Verify" }] }
phase("Find")
const found = await parallel([() => agent("scan a"), () => agent("scan b")])
phase("Verify")
const verified = await pipeline(found.filter(Boolean), (f) => agent("verify " + f, { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }))
return { found, verified }
`

test("two-phase workflow runs, emits progress, journals, and resumes from cache", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const events: string[] = []
      const unsub = Bus.subscribe(WorkflowEvents.Progress, (e) => events.push(e.properties.kind))

      let spawnCount = 0
      const fakeSpawn = async (prompt: string) => {
        spawnCount++
        if (prompt.startsWith("verify")) return { text: `{"ok":true}`, tokens: 1 }
        return { text: prompt.toUpperCase(), tokens: 1 }
      }

      const first = await WorkflowRun.execute({
        sessionID: "ses_int",
        source: SCRIPT,
        scriptPath: "/tmp/audit.js",
        args: undefined,
        spawn: fakeSpawn,
      })

      expect(first.status).toBe("done")
      expect(first.value.found).toEqual(["SCAN A", "SCAN B"])
      expect(first.value.verified).toEqual([{ ok: true }, { ok: true }])
      expect(events).toContain("phase")
      expect(events).toContain("agent")

      const run = await WorkflowJournal.getRun(first.runId)
      expect(run?.status).toBe("done")
      expect(run?.tokens_total).toBe(spawnCount) // 1 token per spawn

      const spawnsAfterFirst = spawnCount
      const resumed = await WorkflowRun.execute({
        sessionID: "ses_int",
        source: SCRIPT,
        scriptPath: "/tmp/audit.js",
        args: undefined,
        resumeFromRunId: first.runId,
        spawn: fakeSpawn,
      })
      expect(resumed.status).toBe("done")
      expect(resumed.value).toEqual(first.value)
      expect(spawnCount).toBe(spawnsAfterFirst) // clean resume: zero new spawns

      unsub()
    },
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `cd packages/aboocode && bun test test/workflow/integration.test.ts`
Expected: PASS (1 test).

> If the resume assertion fails because `parallel`/`pipeline` change `agent()` invocation order between runs, that indicates non-deterministic ordering — re-check that `nextSeq()` is assigned at the synchronous entry of `agent()` (it is, in Task 7) and that the script has no banned nondeterminism. This is the key determinism guarantee from the spec.

- [ ] **Step 3: Run the whole workflow suite**

Run: `cd packages/aboocode && bun test test/workflow/`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/aboocode/test/workflow/integration.test.ts
git commit -m "test(workflow): end-to-end run + resume integration"
```

---

## Self-Review

**Spec coverage:**
- §3 module layout → Tasks 1–11 create every listed file (`types.ts` added as a pure-types helper; noted in File Structure).
- §4 runtime + API → Task 3 (sandbox/guards), Task 7 (agent/parallel/pipeline/phase/log/budget). `workflow()` composition is stubbed in Task 7 and flagged for completion (see Gaps).
- §5 spawn → Task 8.
- §6 structured output → Tasks 4 + 8 (uses existing `json_schema` format with retry).
- §7 budget → Task 2, enforced in Task 7.
- §8 journal/resume/persistence → Tasks 5 + 6 + 10.
- §9 tool/background/permission/registration/gating → Task 11.
- §10 error handling → covered across Tasks 7 (null mapping, caps, budget throw) and 10 (run failure status).
- §11 testing → every task is TDD; Task 12 is the integration test.

**Known gaps / follow-ups (intentional, scoped):**
1. **`workflow()` composition** is stubbed (throws) in Task 7. Full one-level composition (sharing semaphore/counter/budget) is a small follow-up task: load the child source, build a child `RunContext` reusing `ctx.semaphore`/`ctx.budget`/`guardSpawn` with `depth+1` (throw if `depth >= 1`), and call `WorkflowRuntime.evaluate`. Add it as Task 13 if you want it in this milestone; otherwise it ships in spec B alongside saved-workflow `name` resolution. **Flagged, not silently dropped.**
2. **`isolation: "worktree"`** is accepted by the type and parsed but not yet wired into `WorkflowSpawn.run` (Task 8 note). Wire it when a worktree-mutating workflow is exercised.
3. **Background runId fidelity** (Task 11 note): take the `WorkflowRun.start()` refactor to return the real `wfr_` journal id synchronously; the alternative returns a `wf_` handle. Pick one and align the test.
4. **`result.info.tokens` shape** (Task 8 note): verify against `message-v2.ts` `Info` and adjust the accessor.

**Placeholder scan:** No "TBD/TODO/implement later." The two notes (worktree, token shape) are explicit, bounded verification steps with the fallback stated, not vague requirements.

**Type consistency:** `WorkflowTypes.RunContext`, `AgentOpts`, `JournalBinding`, `SpawnFn`, `SpawnResult`, `Budget`, `WorkflowEvent` are defined once in Task 1 and used unchanged in Tasks 6–11. `WorkflowJournal.callKey/createRun/bind/getRun/setStatus`, `WorkflowRun.execute`, `WorkflowEngine.build`, `WorkflowSpawn.run`, `WorkflowBudget.create`, `WorkflowConcurrency.Semaphore/create`, `WorkflowSchema.toFormat/parseResult`, `WorkflowRuntime.parseMeta/evaluate`, and `WorkflowEvents.Started/Progress/Completed` names are consistent across every reference.
