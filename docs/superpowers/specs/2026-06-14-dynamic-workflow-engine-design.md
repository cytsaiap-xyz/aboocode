# Dynamic Workflow Engine — Design Spec

**Date:** 2026-06-14
**Status:** Approved (design)
**Scope:** Sub-project A of 3 (Workflow Engine → Workflow UX → self-paced `/loop`)
**Author:** brainstorming session

---

## 1. Purpose

Add Claude-Code-style **dynamic workflows** to the aboocode core engine: a JavaScript
script — written by the model — that orchestrates many subagents *deterministically*,
executed by a runtime **outside the conversation context** so that only the final result
returns to the session.

This spec covers **only the engine and its `Workflow` tool**. The `/workflows` TUI,
save-as-command, bundled `/deep-research`, `ultracode` mode, and `/loop` changes are
explicitly deferred to follow-up specs B and C.

### Why this is the first sub-project

aboocode already has the orchestration *primitives* — subagent spawning (`tool/task.ts`),
concurrent subtasks (`session/prompt.ts` `executeSubtask` via `Promise.allSettled`), a
DAG delegator (`tool/team.ts` `delegate_tasks`), a cron scheduler, an event bus with SSE
streaming, `BackgroundTasks`, `TaskProgress`, the `Tool.define` framework, and Drizzle/SQLite
persistence. The one genuinely missing piece is a **deterministic, resumable, in-code
orchestrator**. Everything in B and C either leans on this engine or complements it.

### Goal: parity with Claude Code's model

The defining inversion versus subagents/teams: with subagents the *model* is the
orchestrator (it decides turn-by-turn what to spawn, and every result lands in a context
window); with a workflow the **plan lives in code** — loops, branching, and intermediate
results live in script variables, so the conversation only ever sees the synthesized
answer. The orchestration code itself spends **zero model tokens**; only leaf `agent()`
calls cost tokens, each in its own clean context.

---

## 2. Key decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Script sandbox | **In-process `node:vm` context with curated globals** | Matches Claude Code's actual capability model (capability-limited, not a hardened jail); Bun-native; lowest effort; scripts are model-authored (semi-trusted). |
| Resumability | **Full journal + resume now** | Determinism design must be baked in from day one anyway; retrofitting resume later is painful. |
| API surface | **Full parity** | `agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/`workflow()`/`meta`; most map onto existing primitives. |
| `agent()` spawn path | **Call `SessionPrompt.prompt()` directly** | The same primitive `task.ts`/`delegate_task` use; skips conversation-part bookkeeping irrelevant to headless runs. |

---

## 3. Architecture

A new self-contained subsystem `packages/aboocode/src/workflow/`, following the existing
`export namespace X` module idiom.

```
workflow/
  runtime.ts     # node:vm context: curated globals, determinism guards, script eval
  engine.ts      # agent()/parallel()/pipeline()/phase()/log()/budget()/workflow() impls
  spawn.ts       # agent() -> SessionPrompt.prompt() child run + result extraction
  schema.ts      # JSON-Schema -> Zod, structured-output forcing + retry
  journal.ts     # Drizzle persistence: write calls, resume replay/caching
  concurrency.ts # global semaphore (min(16, cores-2)) + 1000-agent run cap
  budget.ts      # token accounting via TaskProgress / usage-log
  run.ts         # WorkflowRun lifecycle: start/background/status/stop/resume
  tool.ts        # the `Workflow` Tool.define
  index.ts       # barrel
```

### Dependency direction

`workflow/` depends *downward only* on `session/` (`SessionPrompt`), `agent/`,
`storage/` (Drizzle), `bus/`, and `tool/`. Nothing in those depends back on `workflow/`
**except** `tool/registry.ts`, which registers the single new `Workflow` tool. This keeps
the engine an independently testable layer.

### Unit responsibilities

- **runtime** — owns the vm context and the script→async-function wrapping. Knows nothing about sessions.
- **engine** — the global functions exposed to scripts. Pure orchestration logic; delegates spawning to `spawn` and persistence to `journal`.
- **spawn** — the only unit that talks to `SessionPrompt`. Turns one `agent()` call into one child-session run.
- **schema** — JSON-Schema↔Zod conversion and the validate/retry loop.
- **journal** — the only unit that talks to the DB. Write-through during a run; replay/cache lookup during resume.
- **concurrency** — a single shared semaphore + the run-level agent counter.
- **budget** — read-only view over token usage.
- **run** — orchestrates a single `WorkflowRun`: creates the row, drives the runtime, handles background execution, status, stop, resume.
- **tool** — the model-facing surface; validates input, persists the script, kicks off `run`.

---

## 4. The runtime & script API

### 4.1 Sandbox

`runtime.ts` builds a `node:vm` context whose globals are **exactly**:

- Orchestration hooks: `agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`, `budget`
- Input: `args`
- Safe builtins: `JSON`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Promise`, `Map`, `Set`, `RegExp`, `Error`, and `Math` **with `random` removed**.

**Excluded** from scope: `require`, `import`/dynamic import, `process`, `fetch`, `fs`,
`Buffer`, `setTimeout`/`setInterval`/timers, `globalThis` escape hatches.

**Determinism guards** (these *throw* when called): `Date.now()`, argless `new Date()`,
`Math.random()`. Rationale: resume keys agent calls by deterministic invocation order;
nondeterminism would invalidate the cache. Timestamps must be passed via `args`; per-call
variety must come from prompt/label/index variation.

The script is `export const meta = {...}` followed by an async body. The runtime strips the
`export` and wraps the remainder as `async function(globals){ ... }`, injects the globals,
awaits it, and captures the return value as the run result. The `meta` literal is parsed
out first and validated (required `name`, `description`; optional `whenToUse`, `phases`,
`model`).

### 4.2 Functions

- **`agent(prompt: string, opts?): Promise<string | object | null>`**
  Spawns one subagent. Returns its final text, or — when `opts.schema` is set — the
  validated object. Returns `null` on terminal failure (so scripts can `.filter(Boolean)`).
  Opts:
  - `label?: string` — display label.
  - `phase?: string` — progress group (use inside `parallel`/`pipeline` to avoid racing the global `phase()`).
  - `schema?: object` — JSON Schema; forces validated structured output (see §6).
  - `model?: string` — model alias (`opus`/`sonnet`/`haiku`/`fable`) or full id; default = run's session model.
  - `isolation?: "worktree"` — run the agent in a fresh git worktree (reuses `AgentIsolation`); for parallel file mutation.
  - `agentType?: string` — custom subagent type from the Agent registry; default `general`.

- **`parallel(thunks: Array<() => Promise<any>>): Promise<any[]>`**
  **Barrier**: awaits all thunks. A throwing thunk resolves to `null` (the call never
  rejects). Concurrency bounded by the global semaphore.

- **`pipeline(items, ...stages): Promise<any[]>`**
  Runs each item through all stages independently, **no barrier between stages** (item A
  can be in stage 3 while item B is in stage 1). Each stage callback receives
  `(prevResult, originalItem, index)`. A stage that throws drops that item to `null` and
  skips its remaining stages.

- **`phase(title: string): void`** — starts a progress group; subsequent `agent()` calls group under it.
- **`log(message: string): void`** — emits a narrator progress line.
- **`args: any`** — the value passed to the `Workflow` tool's `args`, verbatim (`undefined` if absent). Real JSON, not a string.
- **`budget: { total: number|null, spent(): number, remaining(): number }`** — token target view (see §7).
- **`workflow(nameOrRef: string | {scriptPath}, args?): Promise<any>`** — runs another workflow inline, sharing this run's semaphore, agent counter, and budget. **One level only** (nested `workflow()` throws).

### 4.3 Limits

- Up to **`min(16, cores-2)` concurrent agents** (global semaphore).
- **1,000 agents total per run** (counter; throws when exceeded) — runaway backstop.
- A single `parallel()`/`pipeline()` call accepts at most **4,096 items** (explicit error otherwise).

---

## 5. Spawn (`agent()` → child session)

`spawn.ts` implements one `agent()` call:

1. Acquire a semaphore slot; increment + check the run's 1,000-agent counter.
2. Resolve model: `opts.model` (via `Provider.parseModel`) else the run's session model.
3. Create a child session: `Session.create({ parentID: run.sessionID, title: label })`; set up `AgentIsolation` from `opts.isolation` (default shared; `"worktree"` reuses the existing worktree isolation mode).
4. Run: `SessionPrompt.prompt({ sessionID: child.id, agent: opts.agentType ?? "general", model, parts: [{ type: "text", text: prompt }], format })` — where `format` is set only when a schema is requested (§6).
5. Extract the final assistant text from the result parts.
6. Record token usage to the run's budget; write the journal row (§8).
7. Release the slot; return text (or parsed object, or `null`).

Subagents inside a workflow always run in **acceptEdits** permission mode and inherit the
session's tool allowlist, regardless of the launching session's mode (matches Claude
Code's "subagents always run acceptEdits" rule).

---

## 6. Structured output (`schema`)

`schema.ts`:

1. Convert the JSON Schema to a Zod schema.
2. Pass it through `SessionPrompt.prompt`'s existing **`format?: MessageV2.Format`** input
   so the child run is constrained to produce structured output.
3. Validate the child's output against the Zod schema. On mismatch, re-prompt the child up
   to **N=3** times with the validation error appended. After N failures the call resolves
   to `null` (terminal failure).
4. On success, return the parsed object.

This makes `schema` "force a structured-output result with retry-on-mismatch," which is far
more reliable than prompting "please return JSON."

---

## 7. Budget (token accounting)

`budget.ts` exposes a read-only view:

- `budget.total` — a token target parsed from a user directive (e.g. a `+500k` style
  instruction) or `null` when none is set.
- `budget.spent()` — output tokens spent so far across this run (and any inline
  `workflow()` children, which share the pool), sourced from `TaskProgress.tokensUsed` /
  the usage log accumulated per child run.
- `budget.remaining()` — `max(0, total - spent())`, or `Infinity` when `total` is `null`.

When `total` is set it is a **hard ceiling**: once `spent()` reaches it, further `agent()`
calls throw. Scripts use this for `while (budget.total && budget.remaining() > X)` loops.

---

## 8. Journal, resume & persistence

### 8.1 Schema (two new Drizzle tables + migration)

```
workflow_run
  id            text pk
  sessionID     text            -- launching session
  name          text            -- meta.name
  scriptPath    text            -- persisted script location
  status        text            -- running | paused | done | failed | stopped
  argsJson      text null
  model         text null       -- run's resolved session model
  tokensTotal   integer default 0
  createdAt     integer
  updatedAt     integer

workflow_agent_call
  id            text pk
  runId         text fk -> workflow_run.id
  seq           integer         -- monotonic invocation order within the run
  callKey       text            -- hash(seq + prompt + canonical(opts))
  label         text null
  phase         text null
  prompt        text
  optsJson      text null
  resultJson    text null       -- cached result (text or structured object)
  status        text            -- pending | done | failed
  tokens        integer default 0
  startedAt     integer
  endedAt       integer null
```

Persistence reuses `Database.transaction()` / `Database.effect()`.

### 8.2 Journaling

The engine assigns each `agent()` invocation a **monotonic `seq`** at call time.
Invocation order is deterministic because control flow is deterministic — that is the
entire reason `Date.now`/`Math.random`/`new Date()` are banned. On completion the engine
writes `(seq, callKey, result, tokens, status)`.

### 8.3 Resume

`Workflow({ scriptPath, resumeFromRunId })`:

1. Re-run the deterministic script from the top.
2. At each `agent()` call, look up the journal by `seq`:
   - **`callKey` matches** → return the cached `resultJson` instantly (zero model spend).
   - **`callKey` differs** (script edited at/after this call) → run live, and invalidate
     all journal rows with greater `seq`.
3. Same script + same `args` ⇒ 100% cache hit. The first edited/new call and everything
   after it runs live.

Resume is **same-session** (matches Claude Code). Exiting aboocode and relaunching starts
the workflow fresh. Stop the prior run before resuming.

---

## 9. The `Workflow` tool, background execution & permission

### 9.1 Tool

`tool.ts`:

```
Tool.define("workflow", {
  parameters: {
    script?:         string,   // inline script (begins with `export const meta`)
    scriptPath?:     string,   // run a script file (takes precedence over script/name)
    name?:           string,   // run a saved workflow by name (deferred registry; B)
    args?:           any,      // JSON value exposed to the script as `args`
    resumeFromRunId?: string,  // resume a prior run
  }
})
```

Behavior:
1. Resolve the script (scriptPath > script > name) and parse + validate `meta`.
2. Persist the script under the session directory; capture its path.
3. Create the `workflow_run` row.
4. Start the run **in the background** via the existing `BackgroundTasks` registry.
5. Return immediately with `{ runId, scriptPath }`.

### 9.2 Background execution & notification

The run executes outside the conversation; intermediate results live in script variables,
never in the model's context. Progress (`phase`/`log`/per-agent status) streams live as
**bus events** over the existing SSE path. On completion, the final result is surfaced back
to the launching session using the same re-injection mechanism `cron-consumer` /
`BackgroundTasks.drain` already use (a `task-notification`-style system reminder carrying
the run's result).

### 9.3 Permission

Launching a run goes through `ctx.ask()` with a new **`"workflow"` permission**, whose
prompt shows the planned phases from `meta.phases` (the approval-prompt analog). In
non-interactive contexts (`serve`/headless/SDK) the run follows configured permission
rules without an interactive prompt. Spawned agents inherit the session allowlist and run
in acceptEdits (§5).

### 9.4 Registration & gating

Add `WorkflowTool` to the built-in list in `tool/registry.ts`. Gate availability on a
config flag **`experimental.workflows` (default off)** so the engine can land and be tested
"dark" before specs B and C add the user-facing UX.

---

## 10. Error handling

- A throwing thunk in `parallel()` → that slot resolves to `null`; the call never rejects.
- A throwing stage in `pipeline()` → that item drops to `null` and skips remaining stages.
- A terminal agent failure (after schema retries / API retries) → `agent()` returns `null`.
- Exceeding the 1,000-agent cap or the budget ceiling → `agent()` throws (surfaces as run failure).
- Script syntax error / invalid `meta` → the tool call fails fast before any run row is created.
- Runtime exception in the script body → run status `failed`; partial journal is retained; the failure is surfaced to the session.
- A `workflow()` call nested more than one level deep → throws.

All failures are visible: run status + per-call status in the journal, and a completion
notification to the session that names what failed.

---

## 11. Testing

**Unit**
- Determinism guards: `Date.now`/`new Date()`/`Math.random` throw inside a script.
- Sandbox: `require`/`process`/`fetch`/`fs` are undefined in script scope.
- Concurrency: semaphore never exceeds `min(16, cores-2)`; the 1,000-agent counter throws on overflow; >4,096-item `parallel`/`pipeline` errors.
- `parallel` is a barrier and maps thunk failures → `null`.
- `pipeline` has no inter-stage barrier (assert interleaving: item A in stage 3 while B in stage 1) and drops a throwing item → `null`.
- Schema: valid output parses; invalid output retries N times then → `null`.
- Journal: replay returns cached results for matching `callKey`; an edited call runs live and invalidates later rows.
- Budget: `spent()` accumulates; `remaining()` math; ceiling throws.

**Integration**
- A tiny real workflow (2 phases, fast/mocked model) end-to-end: run → journal written →
  stop → resume (assert cache hit on completed calls) → completion notification delivered
  to the session.

All `agent()` spawns are mocked in unit tests (inject a fake spawn) so no real model calls
are needed; the integration test uses a single fast model.

---

## 12. Non-goals (deferred)

Deferred to specs **B** (Workflow UX) and **C** (self-paced `/loop`):

- The `/workflows` TUI (progress tree, pause/resume, drill-in, save-as-command).
- Saved-workflow registry (`name` resolution, `.aboocode/workflows/` + `~/.aboocode/workflows/`).
- The bundled `/deep-research` workflow.
- `ultracode` effort mode and keyword trigger.
- Any `/loop` self-pacing changes (intervals are already covered by the cron subsystem).

The engine ships drivable via the `Workflow` tool and the SDK in the interim.

---

## 13. Open questions / risks

- **`MessageV2.Format` coverage**: structured output depends on the existing `format` field
  fully constraining a child run. If it proves insufficient, fall back to injecting a
  synthetic `StructuredOutput` tool into the child and forcing that tool call. (Resolve
  during implementation by reading `session/prompt.ts` `format` handling first.)
- **vm + async**: `node:vm` under Bun must support awaiting host promises returned by the
  injected globals. Verify early; if Bun's `vm` is limited, the curated-global function
  approach still works by running the wrapped async function with globals passed as
  parameters rather than via a `vm.Context`.
- **Deterministic `seq` under concurrency**: invocation order is deterministic given
  deterministic control flow, but the engine must assign `seq` at the synchronous moment
  `agent()` is *entered*, not when it resolves. Tests must lock this.

---

## 14. Post-implementation status (2026-06-15)

Implemented behind `experimental.workflows` (off by default) across 13 source files +
12 test files, **33 tests passing**. A final holistic review confirmed the runtime,
engine, journal/resume, concurrency caps, gating, and sandbox match §§3–10. The structured
output path was fixed to read `result.info.structured` (the real field where
`SessionPrompt.prompt` stores a `json_schema` answer) rather than a text part.

### Deferred follow-ups before the flag graduates from experimental

These are accepted gaps for the dark launch; address before enabling by default:

1. **acceptEdits posture for spawned child sessions** (§5). `spawn` does not yet create
   children in acceptEdits, so a headless run can block on permission prompts for
   Bash/Edit. `SessionPrompt.prompt` has no mode-override input — the child session must be
   created with the right permission posture.
2. **Wire `ctx.abort`** into `engine.agent` (check before `nextSeq`/spawn) and into
   `spawn`/`SessionPrompt.prompt`, so stopping the session actually halts an in-flight run.
3. **Seed the resume budget** from the persisted `workflow_run.tokens_total` so
   budget-gated control flow (`while (budget.remaining() > X)`) is deterministic across
   resume (currently the in-memory budget restarts at 0 on resume).
4. **Completion re-injection to the session** (§9.2): today completion fires the
   `workflow.completed` bus event and writes `BackgroundTasks` output; verify the launching
   session actually surfaces the final result as a `task-notification`-style reminder.
5. **Resume status guard**: `start()` should refuse (or reset) when `resumeFromRunId`
   points at a still-`running` run, to prevent double-driving the same journal rows.
6. **`workflow()` composition** and **`worktree` isolation** — the two intentionally
   stubbed/unwired items — before advertising full parity.
7. **Awaited DB writes**: `setStatus`/`createRun` use fire-and-forget `Database.use`
   (sync under bun:sqlite today); make the async signatures honest. Validate/normalize
   `opts` at the script boundary (it is `any`, so a non-JSON value would throw in `callKey`).
8. **Real-spawn integration test** for the `schema` case (current tests inject fakes; a
   test against the production spawn path would have caught the `info.structured` bug).
```
