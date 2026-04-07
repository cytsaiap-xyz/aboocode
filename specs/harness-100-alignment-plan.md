# Aboocode Harness Alignment Plan

Date: 2026-04-03

Goal: drive Aboocode as close as possible to full harness alignment with the engineering patterns visible in `ai-agent-deep-dive` and `claude-code-leak`.

Scope: this plan is not about matching Claude Code internals line-for-line. It is about matching the observable harness architecture and operating model shown by the two reference sources.

References:
- `ai-agent-deep-dive/docs/02-tools-permissions-and-execution.md`
- `ai-agent-deep-dive/docs/08-agent-runtime-loop.md`
- `ai-agent-deep-dive/docs/12-workspace-and-isolation.md`
- `claude-code-leak/src/query/transitions.ts`
- `claude-code-leak/src/memdir/memoryTypes.ts`

---

## Success Criteria

Aboocode can be considered strongly aligned when all of the following are true:

1. Isolation is real end-to-end.
Subagents in `read_only`, `temp`, and `worktree` modes execute all file and shell operations inside their effective workspace, not the parent workspace.

2. Inherited context is isolation-aware.
Any file references, prompt attachments, or path metadata passed into a subagent are translated into the subagent's effective root.

3. Read-only mode is enforced by execution boundaries, not only by tool filtering or shell regexes.

4. Completion is policy-driven.
The harness can require verification or quality gates before a task is allowed to stop.

5. Memory is durable and narrow.
The system stores reusable user/project facts, not transient repo-state snapshots or architecture dumps.

6. The above guarantees are proven by integration tests, not only unit tests.

---

## Current Remaining Gaps

### Gap 1: Isolation is only partial

Current code creates isolation contexts in [isolation.ts](../packages/aboocode/src/agent/isolation.ts), and `bash` uses the isolated `cwd`, but file tools still resolve against the main workspace:
- [read.ts](../packages/aboocode/src/tool/read.ts)
- [write.ts](../packages/aboocode/src/tool/write.ts)
- [edit.ts](../packages/aboocode/src/tool/edit.ts)
- [apply_patch.ts](../packages/aboocode/src/tool/apply_patch.ts)
- [glob.ts](../packages/aboocode/src/tool/glob.ts)
- [grep.ts](../packages/aboocode/src/tool/grep.ts)
- [ls.ts](../packages/aboocode/src/tool/ls.ts)

Reference basis:
- Deep dive workspace model: `12-workspace-and-isolation.md`
- Deep dive execution model: `02-tools-permissions-and-execution.md`

### Gap 2: Prompt file resolution is not isolation-aware

`resolvePromptParts()` in [prompt.ts](../packages/aboocode/src/session/prompt.ts) still resolves file references against the main `Instance.worktree` instead of the session isolation root.

Reference basis:
- Deep dive workspace model: `12-workspace-and-isolation.md`

### Gap 3: Read-only shell protection is heuristic

`read_only` currently relies on a regex in [isolation.ts](../packages/aboocode/src/agent/isolation.ts) and a check in [bash.ts](../packages/aboocode/src/tool/bash.ts). That is still weaker than real execution isolation.

Reference basis:
- Deep dive governed execution flow: `02-tools-permissions-and-execution.md`
- Runtime stop/continue rigor: `08-agent-runtime-loop.md`

### Gap 4: Completion policy is still lightweight

The quality gate exists, but the harness is not yet consistently structured around a verification-driven stop decision for risky tasks.

Reference basis:
- Deep dive runtime loop and control flow: `08-agent-runtime-loop.md`
- Claude transition model: `src/query/transitions.ts`

### Gap 5: Memory discipline can still drift

The memory prompts are improved, but the durable-memory boundary still needs to be enforced as a system rule.

Reference basis:
- `claude-code-leak/src/memdir/memoryTypes.ts`

### Gap 6: Integration proof is incomplete

Current tests prove individual pieces, but not the full harness guarantees.

Reference basis:
- Both references imply system-level behavior, not just local unit behavior

---

## Implementation Plan

## Phase 1: Finish Real Workspace Isolation ✅

Priority: Critical — DONE

Target: every tool must operate on the effective isolation workspace for that session.

Reference:
- `ai-agent-deep-dive/docs/12-workspace-and-isolation.md`
- `ai-agent-deep-dive/docs/02-tools-permissions-and-execution.md`

### 1.1 Add a shared path resolver for isolated sessions ✅

Create a small helper that resolves:
- effective `cwd`
- effective `root`
- relative-to-root display paths
- translation of parent workspace paths into the isolated workspace

Suggested file:
- `packages/aboocode/src/agent/isolation-path.ts`

Suggested API:

```ts
export namespace IsolationPath {
  export function cwd(sessionID: string): string
  export function root(sessionID: string): string
  export function resolve(sessionID: string, input: string): string
  export function relative(sessionID: string, input: string): string
  export function translate(sessionID: string, input: string): string
}
```

Reason:
- avoid each tool reimplementing `Instance.directory` / `Instance.worktree` fallback logic
- make the isolation rules consistent across all tools

### 1.2 Rewire all filesystem tools to use the isolation resolver ✅

Update:
- `src/tool/read.ts`
- `src/tool/write.ts`
- `src/tool/edit.ts`
- `src/tool/apply_patch.ts`
- `src/tool/glob.ts`
- `src/tool/grep.ts`
- `src/tool/ls.ts`

Required changes:
- resolve relative input paths against the session isolation `cwd`
- compute display titles and permission patterns relative to the session isolation `root`
- ensure `temp` and `worktree` tools never silently fall back to the parent repo

Acceptance criteria:
- no filesystem tool uses `Instance.directory` or `Instance.worktree` directly for session-relative path resolution
- relative paths inside an isolated subagent stay inside its isolated root

### 1.3 Tighten external-directory checks for isolated sessions ✅

`assertExternalDirectory()` should understand the effective session root.

Required behavior:
- a path inside a worktree is internal for that worktree session
- a path inside a temp workspace is internal for that temp session
- a path back into the parent repo is external unless explicitly allowed

Files likely involved:
- `src/tool/external-directory.ts`
- any helper used by `Instance.containsPath`

Acceptance criteria:
- isolated sessions cannot mutate the parent repo through a file tool by passing a crafted absolute path

### 1.4 Make worktree and temp cleanup auditable

Cleanup already exists, but it should be observable and testable.

Required behavior:
- cleanup runs on success, cancellation, and failure
- logs include session ID and isolation mode
- failures to remove worktrees are surfaced as warnings with enough context to debug

Acceptance criteria:
- no leaked temp dirs in normal flow
- no hidden cleanup failures

---

## Phase 2: Make Prompt and Context Translation Isolation-Aware ✅

Priority: Critical — DONE

Target: inherited file context must refer to the subagent's workspace, not the parent's workspace.

Reference:
- `ai-agent-deep-dive/docs/12-workspace-and-isolation.md`

### 2.1 Rework `resolvePromptParts()` to accept session context ✅

Current issue:
- it resolves against the parent root unconditionally

Required change:
- pass `sessionID` or an explicit isolation context into `resolvePromptParts()`
- use the session root for relative file references

Suggested signature:

```ts
export async function resolvePromptParts(
  template: string,
  options?: { sessionID?: string; root?: string; cwd?: string }
)
```

Acceptance criteria:
- `@foo.ts` inside a worktree agent resolves inside the worktree
- `@foo.ts` inside a temp agent resolves inside the temp workspace

### 2.2 Translate inherited absolute file paths

When a parent session passes an absolute file path into a worktree agent, translate that path into the matching path inside the worktree when possible.

Use:
- `AgentIsolation.translatePath()`

Apply translation in:
- prompt file parts
- tool-call wrapper metadata
- subtask context injection
- any future file reference mechanism

Acceptance criteria:
- if parent references `/repo/src/x.ts`, worktree child sees `/repo-worktree/src/x.ts`
- paths outside the project remain unchanged

### 2.3 Fix session/subtask metadata to report effective paths

`SubtaskPart` handling and assistant message creation should emit:
- effective isolated `cwd`
- effective isolated `root`

This does not create safety by itself, but it is necessary for observability and debugging.

Acceptance criteria:
- message path metadata matches actual execution workspace

---

## Phase 3: Replace Heuristic Read-Only Shell Blocking With Real Policy ✅

Priority: High — DONE

Target: `read_only` mode must be enforced by capabilities, not mainly by string matching.

Reference:
- `ai-agent-deep-dive/docs/02-tools-permissions-and-execution.md`
- `ai-agent-deep-dive/docs/08-agent-runtime-loop.md`

### 3.1 Decide the allowed shell model for `read_only`

Recommended option:
- keep `bash` available in `read_only`
- but run it with a stronger write boundary

Implementation options:
1. Best: execute inside a read-only mounted or sandboxed workspace
2. Good: execute only in a detached temp/worktree clone that can be discarded
3. Acceptable: disable `bash` entirely for `read_only` agents

Recommendation:
- choose option 3 first if speed matters
- choose option 2 if you want Claude-style behavior with lower OS complexity

### 3.2 Remove regex as the primary enforcement layer

The regex can remain as a defense-in-depth warning, but it should not be the main boundary.

Required outcome:
- even if the command is creative or obfuscated, it still cannot modify the protected workspace

Acceptance criteria:
- read-only safety does not depend on the shell command string matching a denylist

### 3.3 Align permission prompts with the effective workspace

If shell remains enabled:
- permission metadata should show the effective workdir and workspace mode
- parent-repo mutations should never be described as local safe operations from a read-only worker

Acceptance criteria:
- permission and audit output accurately reflect real execution scope

---

## Phase 4: Make Stop Decisions Policy-Driven ✅

Priority: High — DONE

Target: the harness should decide whether a task may stop based on verification policy, not only on model completion.

Reference:
- `ai-agent-deep-dive/docs/08-agent-runtime-loop.md`
- `claude-code-leak/src/query/transitions.ts`

### 4.1 Classify tasks by required verification level

Add a small policy model:
- exploration: no verification required
- planning: no verification required
- implementation: verification recommended
- risky implementation: verification required

Suggested place:
- agent definitions or session policy config

### 4.2 Support verification as a first-class subagent or stop hook

Two valid designs:
1. spawn a dedicated verification agent
2. execute verification checks in the stop hook pipeline

Recommended approach:
- use the current quality gate as the base
- allow escalation into a verification agent for more complex tasks

### 4.3 Make stop outcomes explicit in the loop

The loop should distinguish:
- model completed and verification passed
- model completed but verification blocked stop
- model completed but more work is required

This is already partially present, but should become policy-based rather than ad hoc.

Acceptance criteria:
- risky tasks can be forced back into the loop until verification passes or a terminal blocked state is reached

---

## Phase 5: Harden Memory Discipline ✅

Priority: Medium — DONE

Target: memory should preserve durable context without accumulating stale repo-state.

Reference:
- `claude-code-leak/src/memdir/memoryTypes.ts`

### 5.1 Define a hard allowlist for durable memory

Keep:
- user preferences
- stable project conventions
- persistent workflows
- recurring environment constraints

Reject:
- file listings
- current architecture snapshots
- one-off implementation details
- temporary investigation notes
- current branch or current repo state unless explicitly marked durable

### 5.2 Enforce memory validation before write

Add a validation layer before appending to memory:
- classify candidate memory
- reject low-durability items
- optionally annotate source and confidence

### 5.3 Add stale-memory handling

When memory is retrieved:
- present it as recall, not truth
- revalidate if it affects current execution

Acceptance criteria:
- memory files trend toward stable facts, not noisy repo notes

---

## Phase 6: Add Harness Integration Tests ✅

Priority: Critical — DONE

Target: prove the system behavior end-to-end.

Reference:
- all of the above references imply harness-level guarantees

### 6.1 Isolation tests

Add tests for:
- worktree agent writes a file and parent repo stays unchanged
- temp agent writes a file and parent repo stays unchanged
- read-only agent cannot write through `write`
- read-only agent cannot write through `edit`
- read-only agent cannot write through `apply_patch`
- read-only shell cannot modify the protected workspace

### 6.2 Prompt translation tests

Add tests for:
- relative `@file` resolution inside worktree agent
- absolute parent path translation into worktree agent
- non-project absolute path remains unchanged

### 6.3 Policy/verification tests

Add tests for:
- implementation task blocked by quality gate
- verification passes and task stops cleanly
- stop hook continuation injects feedback and re-enters loop

### 6.4 Cleanup tests

Add tests for:
- worktree removed after success
- worktree removed after failure
- temp dir removed after cancellation

Acceptance criteria:
- the harness claims are backed by end-to-end tests under `packages/aboocode/test`

---

## Recommended Delivery Order

1. Phase 1: full filesystem isolation
2. Phase 2: prompt/context translation
3. Phase 6.1 and 6.2: isolation integration tests
4. Phase 3: real read-only shell policy
5. Phase 4: stronger verification-driven stop logic
6. Phase 5: memory hardening
7. Phase 6.3 and 6.4: policy and cleanup tests

Reason:
- full isolation is the largest remaining mismatch against both the deep dive and the Claude-style harness model
- the rest becomes much easier to evaluate once workspace boundaries are real

---

## Definition of Done

This plan is done when:

1. isolated sessions no longer resolve file operations against the parent workspace
2. inherited file references are translated into the effective isolated root
3. read-only mode no longer depends primarily on a shell regex denylist
4. stop decisions can require verification for risky tasks
5. memory only stores durable, reusable context
6. integration tests prove the above behavior

At that point, Aboocode will be much closer to "full harness alignment" as far as the available references can justify.
