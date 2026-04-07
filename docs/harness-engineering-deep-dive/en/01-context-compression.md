# 01. 3-Layer Context Compression

## 1. Why Context Management is Top Priority

The LLM's context window is a finite resource. A typical engineering session may involve dozens of tool calls, each returning hundreds of lines. Without active management, context overflows after 10-20 tool calls, causing:
- API errors and interruption
- Model loses task context
- Cost explosion

One of Claude Code's core advantages is its 3-layer compression strategy — Aboocode fully replicates this architecture.

## 2. 3-Layer Compression Model

```
┌─────────────────────────────────────────────┐
│ Layer 1: Micro-Compact                       │
│ Trigger: Before each LLM call                │
│ Action: Clear old tool results, keep last N  │
│ Cost: Zero (no LLM call)                     │
├─────────────────────────────────────────────┤
│ Layer 2: Proactive Compact                    │
│ Trigger: Token usage >= 80% threshold         │
│ Action: LLM summarizes history messages       │
│ Cost: One LLM call                            │
├─────────────────────────────────────────────┤
│ Layer 3: Reactive Compact                     │
│ Trigger: Token >= 95% or API overflow error   │
│ Action: Emergency compress + rebuild context  │
│ Cost: One LLM call + possible detail loss     │
└─────────────────────────────────────────────┘
```

## 3. Layer 1: Micro-Compact

### 3.1 Requirement

Before each LLM call, the system must automatically clear old tool execution results, keeping only the most recent N (default 5). Cleared results are replaced with `[Old tool result content cleared]`.

### 3.2 Compactable Tools

Not all tool results can be safely cleared. The following tools' historical results can be micro-compacted:

```typescript
const MICRO_COMPACTABLE_TOOLS = new Set([
  "bash", "read", "grep", "glob",
  "edit", "write", "webfetch", "websearch"
])
```

The following tool results **cannot** be compacted (they have lasting effects on reasoning):
- `task` (task state)
- `question` (user answers)
- `skill` (skill output)
- `memory-read` / `memory-write`

### 3.3 Pseudocode

```python
def micro_compact(session_id, keep_recent=5):
    messages = get_messages(session_id)
    tool_count = 0

    for msg in reversed(messages):
        for part in msg.parts:
            if part.type != "tool_result":
                continue
            if part.tool not in COMPACTABLE_TOOLS:
                continue
            if part.already_compacted:
                continue

            tool_count += 1
            if tool_count > keep_recent:
                part.content = "[Old tool result content cleared]"
                part.compacted_at = now()
                update_part(session_id, msg.id, part)
```

### 3.4 Effect

Micro-compaction can reduce context usage by 40-60% without calling the LLM. This means:
- Users can execute 2-3x more tool calls before proactive compaction triggers
- Zero-cost compression (no token consumption)
- Model still sees full results of the 5 most recent tool calls

## 4. Layer 2: Proactive Compact

### 4.1 Requirement

When token usage reaches 80% of the context window, the system triggers proactive compaction:
1. Save full conversation to disk (Phase 2 Transcript)
2. Call LLM to summarize history into a single summary
3. Replace old messages with summary
4. Inject identity context (Phase 3 Identity)

### 4.2 Pseudocode

```python
def proactive_compact(session_id):
    state = token_budget.get_state(session_id)
    if state.current_estimate < state.compact_threshold:
        return

    messages = get_messages(session_id)
    transcript.save(session_id, messages)
    summary = llm.summarize(messages)
    replace_messages(session_id, [summary_message(summary)])
    set_post_compaction(session_id, {
        agent: current_agent,
        cwd: current_working_directory
    })
```

## 5. Layer 3: Reactive Compact

### 5.1 Requirement

When the model API returns a `prompt_too_long` error, the system should not stop. Instead:
1. Immediately trigger micro-compact (aggressive: `keep_recent=2`)
2. If still over limit, trigger proactive compact
3. After compression, automatically retry the current turn

### 5.2 Pseudocode

```python
def handle_prompt_too_long(session_id):
    micro_compact(session_id, keep_recent=2)
    state = recalculate_budget(session_id)
    if state.still_over_limit:
        proactive_compact(session_id)
    return Transition.Continue
```

## 6. Token Budget Calculation

### 6.1 Core Formula

```
maxOutput = min(model.limit.output, 16384)
rawMaxInput = model.limit.input ?? (model.limit.context - maxOutput)
maxInput = max(rawMaxInput, 0)  // Zero guard

compactThreshold = maxInput * 0.8
reactiveThreshold = maxInput * 0.95
```

### 6.2 Zero Guard

**Critical lesson learned**: If model config is missing `limit.context` (e.g., custom provider), `rawMaxInput` becomes negative, making the compaction threshold negative, triggering compaction on every message.

Fix:
```typescript
const maxInput = rawMaxInput > 0 ? rawMaxInput : 0

export function shouldCompact(state: State): boolean {
  if (state.maxInputTokens <= 0) return false
  return state.currentEstimate >= state.compactThreshold
}
```

## 7. Acceptance Criteria

- [ ] After 10+ tool calls, old tool results show `[Old tool result content cleared]`
- [ ] Micro-compact makes no LLM API calls
- [ ] Proactive compact triggers at 80% token usage
- [ ] API `prompt_too_long` error auto-recovers instead of crashing
- [ ] Missing `limit` config does not cause infinite compaction loop
- [ ] Full conversation saved to disk before compaction

## 8. Source Files

| File | Responsibility |
|------|------|
| `src/session/compaction.ts` | Micro-compact + proactive compact logic |
| `src/session/token-budget.ts` | Token budget calculation + thresholds |
| `src/session/prompt.ts` | Trigger micro-compact before each LLM call |
| `src/session/processor.ts` | Reactive compact (catch API errors) |

## 9. Product Manager Summary

> Context is not infinite — the system must manage tokens like an OS manages memory: save where possible (micro-compact), compress when needed (proactive compact), rescue on error (reactive compact), and never fall into an infinite loop due to missing configuration.
