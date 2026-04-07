# Aboocode Bug Fix Plan And Harness Assessment

Date: 2026-04-03

This document captures the current review findings for Aboocode, a concrete fixing plan, and an assessment of how closely the current implementation matches the Claude Code style of harness engineering described in:

- `https://github.com/tvytlx/ai-agent-deep-dive`
- `~/Documents/Claude_Project/claude-code-leak`

It does not include code changes.

## Executive Summary

Aboocode already has several important harness pieces:

- schema-defined tools
- permission rules with `allow` / `ask` / `deny`
- session-based execution
- child sessions for delegated work
- a multi-agent orchestration layer
- a persistent memory feature

The main issue is that these pieces are not composed with the same rigor as the Claude Code style harness.

The highest-risk gaps are:

1. delegated workers are not isolated from the main workspace
2. delegated dependency handling is unsafe after upstream failure
3. team lifecycle enforcement is incomplete
4. memory collection is too permissive and likely to accumulate stale or low-signal repo-state notes

## Confirmed Issues

## 1. Delegated Workers Are Not Isolated

### Severity

High

### Impact

Subagents created by the orchestrator currently run with broad write and shell permissions against the shared project workspace.

That means:

- one delegated task can modify unrelated files
- multiple delegated tasks can interfere with each other
- exploration or review agents are not meaningfully read-only
- risky implementation work is not separated from the main workspace

### Evidence

- [`packages/aboocode/src/tool/team.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/team.ts#L103)
  The generated agent frontmatter grants:
  - `read: allow`
  - `write: allow`
  - `edit: allow`
  - `bash: allow`
- [`packages/aboocode/src/tool/team.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/team.ts#L234)
  `delegate_task` creates a child session but does not create an isolated workspace.
- [`packages/aboocode/src/tool/team.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/team.ts#L325)
  `delegate_tasks` does the same for parallel execution.

### Why This Conflicts With The Harness Reference

The deep-dive workspace spec explicitly requires role-based isolation and calls out read-only, temp, and worktree modes:

- [`docs/12-workspace-and-isolation.md`](/Users/steventsai/Documents/Claude_Project/ai-agent-deep-dive/docs/12-workspace-and-isolation.md#L5)

The embedded `opencode-reference` also contains an isolation module that is not active in the current Aboocode path:

- [`opencode-reference/packages/opencode/src/worktree/isolation.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/opencode-reference/packages/opencode/src/worktree/isolation.ts)

### Fix Plan

1. Define isolation modes per agent role.
2. Default `explore`, `plan`, and review-like agents to read-only.
3. Default risky implementation subtasks to worktree isolation, not shared workspace.
4. Add temp workspace support for verification or scratch-script tasks.
5. Translate inherited file references when a child task runs in a worktree.
6. Clean up temp/worktree resources when the child session finishes or aborts.

### Recommended Implementation Direction

- Introduce a runtime isolation context for child sessions.
- Make tool execution consult that context before allowing write-capable tools.
- Do not rely on prompt text alone for read-only behavior.

### Verification

- add tests proving read-only agents cannot edit project files
- add tests proving worktree tasks do not modify the main workspace directly
- add tests proving cleanup occurs on success and abort

## 2. `delegate_tasks` Runs Dependents After Failed Prerequisites

### Severity

High

### Impact

Dependent tasks can run even when their prerequisites failed.

That means a downstream worker may:

- run with incomplete context
- produce misleading results
- hide the true cause of failure behind secondary errors

### Evidence

- [`packages/aboocode/src/tool/team.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/team.ts#L384)
  A task is considered ready when every dependency is either completed or failed.
- [`packages/aboocode/src/tool/team.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/team.ts#L338)
  Only completed dependency outputs are injected into the child task context.

So a failed dependency still unblocks execution, but contributes no usable context.

### Root Cause

Dependency resolution currently treats failure as equivalent to completion for scheduling.

### Fix Plan

1. Change readiness logic so only successful dependencies unblock a dependent task.
2. Mark downstream tasks as skipped when any required dependency fails.
3. Report skipped tasks distinctly from execution failures.
4. Preserve the upstream failure message in the skipped task output.

### Verification

- add a test where `A` fails and `B depends_on A`
- assert `B` does not run
- assert output reports `B` as skipped because `A` failed

## 3. `delegate_task` Does Not Enforce Finalized Team State

### Severity

Medium

### Impact

The tool description says the team must be finalized before delegation, but the implementation does not enforce that.

This creates inconsistent behavior:

- prompts and UI imply one workflow
- runtime behavior allows another
- team state becomes advisory instead of authoritative

### Evidence

- [`packages/aboocode/src/tool/team.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/team.ts#L215)
  The description says delegation should happen after finalize.
- [`packages/aboocode/src/tool/team.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/team.ts#L220)
  The implementation only checks whether the agent exists.

It does not verify:

- that a team exists
- that the team is finalized
- that the target agent belongs to the current team

### Fix Plan

1. Require an active finalized team before any delegation.
2. Reject delegation to agents outside the current team roster.
3. Return explicit error messages for:
   - no team
   - team not finalized
   - agent not part of team
4. Align tool descriptions with actual enforced behavior.

### Verification

- add tests for each rejected state
- add a positive test showing delegation succeeds only after finalize

## 4. Memory System Encourages Low-Signal And Stale Repo-State Capture

### Severity

Medium

### Impact

The current memory design is likely to accumulate:

- architecture snapshots
- coding conventions already visible in code
- file-path-heavy notes
- session recap noise

This lowers signal quality and increases the chance that future sessions act on stale memory instead of current code.

### Evidence In Aboocode

- [`packages/aboocode/src/memory/context.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/memory/context.ts#L17)
  Instructs the model to review memory for decisions, patterns, and lessons before tasks.
- [`packages/aboocode/src/agent/prompt/observer.txt`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/agent/prompt/observer.txt#L9)
  Explicitly asks for architecture, conventions, patterns, file paths, and project notes.
- [`packages/aboocode/src/agent/agent.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/agent/agent.ts#L243)
  The memory extractor focuses on decisions, patterns, bugs fixed, and lessons learned.
- [`packages/aboocode/src/memory/index.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/memory/index.ts#L78)
  On session idle, the system both merges observer notes into `MEMORY.md` and then runs a second extraction pass.

### Contrast With Claude Code Memory Guidance

The Claude Code leak material explicitly says not to save:

- code patterns
- conventions
- architecture
- file paths
- frozen repo snapshots

See:

- [`claude-code-leak/src/memdir/memoryTypes.ts`](/Users/steventsai/Documents/Claude_Project/claude-code-leak/src/memdir/memoryTypes.ts#L183)
- [`claude-code-leak/src/memdir/memoryTypes.ts`](/Users/steventsai/Documents/Claude_Project/claude-code-leak/src/memdir/memoryTypes.ts#L201)
- [`claude-code-leak/src/memdir/memoryTypes.ts`](/Users/steventsai/Documents/Claude_Project/claude-code-leak/src/memdir/memoryTypes.ts#L245)

### Fix Plan

1. Narrow the memory taxonomy to durable non-derivable facts.
2. Stop storing architecture and file-structure summaries in persistent memory.
3. Keep session notes separate from durable memory.
4. Remove the double-write pattern on idle:
   - either observer session notes feed memory
   - or extractor writes memory
   - not both by default
5. Add freshness guidance:
   - verify memory claims against current files before relying on them
6. Support explicit memory categories such as:
   - user
   - feedback
   - project
   - reference

### Verification

- add tests that memory prompts exclude derivable repo-state categories
- add tests that stale memory is not blindly trusted when files disagree
- add tests that one idle event does not append duplicate memory summaries

## 5. Team Feature Coverage Exists, But Critical Scenarios Are Untested

### Severity

Medium

### Impact

The team feature has passing tests, but the highest-risk execution paths are not covered.

### Evidence

These tests passed under Bun:

- [`packages/aboocode/test/team/manager.test.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/test/team/manager.test.ts)
- [`packages/aboocode/test/team/team-tools.test.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/test/team/team-tools.test.ts)

But current team tool coverage does not test:

- failed dependency propagation
- skipped dependents
- required finalized team before delegation
- workspace isolation behavior

### Fix Plan

1. Add failure-path tests for dependent task scheduling.
2. Add tests for finalized team enforcement.
3. Add isolation tests once the isolation layer exists.
4. Add end-to-end tests with parallel delegated tasks touching disjoint files.

## Prioritized Fix Order

## Phase 1: Safety And Correctness

1. fix dependency failure propagation in `delegate_tasks`
2. enforce finalized team state in `delegate_task` and `delegate_tasks`
3. restrict default delegated worker permissions

## Phase 2: Harness Isolation

1. add shared / readonly / temp / worktree isolation modes
2. route child sessions through isolation-aware execution
3. clean up temporary resources reliably

## Phase 3: Memory Quality

1. separate session notes from durable memory
2. remove derivable repo-state from memory prompts
3. add freshness verification guidance and category structure

## Phase 4: Test Coverage

1. add regression tests for all above behavior
2. add package-local integration tests for parallel delegation
3. add memory-quality regression tests

## Harness Assessment

## Overall Assessment

Aboocode partially fulfills the Claude Code style harness engineering goals, but it does not yet meet the stronger standard shown in the reference materials.

Current status:

- tool layer: partially aligned
- permission layer: partially aligned
- subagent orchestration: present but weakly governed
- workspace isolation: largely missing in active runtime paths
- memory system: present but lower-discipline than the reference
- verification and governance: incomplete

## What Aboocode Already Does Well

### 1. Tooling Is Formalized

Aboocode has explicit tool definitions, schemas, and tool registry mechanics:

- [`packages/aboocode/src/tool/tool.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/tool.ts)
- [`packages/aboocode/src/tool/registry.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/tool/registry.ts)

This is aligned with the harness requirement that tools be first-class runtime objects rather than prompt-only suggestions.

### 2. Permissions Exist At Runtime

Aboocode has a real permission evaluation and prompting system:

- [`packages/aboocode/src/permission/next.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/permission/next.ts)
- [`packages/aboocode/src/permission/index.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/packages/aboocode/src/permission/index.ts)

This is materially aligned with the deep-dive requirement for user-controlled allow/ask/deny boundaries.

### 3. Sessions And Child Sessions Are Real

Delegated work is not just prompt text. It creates child sessions and routes work through the session engine.

That is a real harness feature, not a fake orchestration layer.

## Where Aboocode Falls Short

### 1. Isolation Is Not Enforced

This is the largest gap.

The deep-dive spec expects role-based isolation and recommends:

- explore -> read-only
- plan -> read-only
- verify -> read-only plus temp write
- risky implementation -> worktree

See:

- [`docs/12-workspace-and-isolation.md`](/Users/steventsai/Documents/Claude_Project/ai-agent-deep-dive/docs/12-workspace-and-isolation.md#L34)

The current Aboocode multi-agent flow does not enforce that model.

### 2. Governance Pipeline Is Not Fully Realized

The deep-dive tool execution model calls for:

1. tool lookup
2. schema validation
3. custom validation
4. pre-hooks
5. permission resolution
6. execution
7. telemetry
8. post-hooks
9. formatted result

See:

- [`docs/02-tools-permissions-and-execution.md`](/Users/steventsai/Documents/Claude_Project/ai-agent-deep-dive/docs/02-tools-permissions-and-execution.md#L33)

Aboocode has parts of this, but the full governed execution chain is not consistently enforced across the active runtime.

The embedded `opencode-reference` even contains a governance module that is not represented in the current active code path:

- [`opencode-reference/packages/opencode/src/tool/governance.ts`](/Users/steventsai/Documents/Claude_Project/Aboocode/opencode-reference/packages/opencode/src/tool/governance.ts)

### 3. Memory Model Is Too Broad

Claude Code’s memory guidance is intentionally narrow and freshness-aware.

Aboocode’s memory system is closer to:

- project note accumulation
- meeting-minute capture
- architectural recap

That is useful for human documentation, but it is weaker as agent memory because it increases stale-context risk.

### 4. Parallelism Exists Without Enough Guard Rails

`delegate_tasks` provides concurrency, but without:

- strong dependency semantics
- isolated workspaces
- conflict-aware ownership
- robust downstream skip behavior

That means Aboocode has the shape of agent teamwork, but not the same execution safety as the target harness style.

## Bottom-Line Assessment

If the target is “Aboocode has some Claude Code inspired harness features,” the answer is yes.

If the target is “Aboocode currently fulfills the harness engineering standard shown in the deep-dive and Claude Code leak references,” the answer is no, not yet.

The most accurate summary is:

> Aboocode has a credible harness foundation, but its current multi-agent execution is still closer to shared-workspace orchestration than to fully governed, isolation-aware Claude Code style harness engineering.

## Recommended Next Milestone Definition

A reasonable milestone for claiming stronger harness alignment would be:

1. delegated workers run in enforced isolation modes
2. dependency scheduling is failure-safe
3. team lifecycle rules are runtime-enforced
4. memory is narrowed to durable non-derivable facts
5. regression tests cover those guarantees

Once those are in place, Aboocode would be much closer to the Claude Code style of harness engineering in substance rather than just feature shape.
