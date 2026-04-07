# 00. Aboocode Harness Engineering Overview

## 1. What is Harness Engineering

Harness Engineering refers to the runtime governance architecture built around large language models. It is not the model's own capability, but the systems engineering outside the model — including context management, tool execution chains, permission governance, task scheduling, memory persistence, failure recovery, and more.

Aboocode's Harness Engineering references Claude Code's leaked source and the ai-agent-deep-dive product requirement specification. While remaining provider-agnostic, it implements 13 core subsystems.

## 2. Why Harness Engineering is Needed

### 2.1 Limits of the Model

LLMs can reason, generate code, and understand natural language, but they:
- Have no persistent memory
- Have no execution environment awareness
- Have no concept of permissions
- Have no task tracking ability
- Lose context in long conversations
- Cannot self-verify

### 2.2 Shortcomings of Simple Agents

Problems with simple agents (model + tool-calling loop):
- Context grows infinitely until token overflow
- No tool governance — model can do anything
- All knowledge lost when session ends
- Cannot decompose complex tasks
- No recovery strategy when errors occur
- Cannot execute independent operations concurrently

### 2.3 Aboocode's Solution

Aboocode upgrades "model + tools" into a controllable, extensible, productizable AI engineering execution system through 13 Harness Phases:

```
Phase  0: 3-Layer Context Compression
Phase  1: System Prompt Dynamic Boundary
Phase  2: Transcript Persistence
Phase  3: Identity Re-injection After Compaction
Phase  4: Native Memory System
Phase  5: Streaming Tool Executor
Phase  6: Enhanced Hook System
Phase  7: Deferred Tool Loading
Phase  8: Background Agent Execution
Phase  9: Tool Governance Pipeline
Phase 10: Verification Agent
Phase 11: Workspace Isolation Modes
Phase 12: Failure Recovery Pipeline
```

## 3. Architecture Layers

```
┌──────────────────────────────────────────────┐
│     User Interaction Layer (TUI / CLI)        │
├──────────────────────────────────────────────┤
│     Session Management Layer                  │
│  ┌──────────┬───────────┬──────────────────┐ │
│  │Compression│ Recovery  │ Identity Inject  │ │
│  │Phase 0    │ Phase 12  │ Phase 3          │ │
│  └──────────┴───────────┴──────────────────┘ │
├──────────────────────────────────────────────┤
│     Tool Execution Layer                      │
│  ┌──────────┬───────────┬──────────────────┐ │
│  │Governance │ Concurrent│ Deferred Loading │ │
│  │Phase 9    │ Phase 5   │ Phase 7          │ │
│  └──────────┴───────────┴──────────────────┘ │
├──────────────────────────────────────────────┤
│     Agent Orchestration Layer                 │
│  ┌──────────┬───────────┬──────────────────┐ │
│  │Background │ Verify    │ Workspace Isolat │ │
│  │Phase 8    │ Phase 10  │ Phase 11         │ │
│  └──────────┴───────────┴──────────────────┘ │
├──────────────────────────────────────────────┤
│     Persistence Layer                         │
│  ┌──────────┬───────────┬──────────────────┐ │
│  │Memory     │ Transcript│ Prompt Cache     │ │
│  │Phase 4    │ Phase 2   │ Phase 1          │ │
│  └──────────┴───────────┴──────────────────┘ │
├──────────────────────────────────────────────┤
│     Extensibility Layer                       │
│  ┌────────────────────────────────────────┐  │
│  │  Plugin / Hook / MCP — Phase 6         │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

## 4. Comparison with Claude Code

| Capability | Claude Code | Aboocode | Difference |
|------|------------|----------|------|
| Context Compression | 3-layer | 3-layer (same design) | Identical |
| Prompt Caching | Anthropic cache_control | Provider-agnostic sections | Aboocode supports any provider |
| Transcript | Internal storage | Local JSONL files | Aboocode offline-accessible |
| Memory | File-based Markdown | File-based Markdown | Similar |
| Tool Concurrency | Concurrency-safe flag | Mutex + queue | Different impl, same goal |
| Tool Governance | 8-step chain | 8-step chain | Identical |
| Deferred Loading | ToolSearch | ToolSearch | Identical |
| Verification | No independent verifier | Independent read-only verifier | Aboocode stronger |
| Workspace Isolation | Worktree mode | 5-level isolation | Aboocode finer-grained |
| Failure Recovery | Basic retry | Classified recovery pipeline | Aboocode more complete |

## 5. Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **AI SDK**: Vercel AI SDK (provider-agnostic)
- **Database**: SQLite (via Drizzle ORM)
- **TUI**: Ink (React for CLI)
- **Plugin System**: Custom Plugin namespace

## 6. Product Manager Summary

> Aboocode's Harness Engineering is not a wrapper around a model — it is a complete runtime governance architecture that enables AI to manage context, govern tools, persist memory, decompose tasks, isolate risks, auto-recover from failures, and be independently verified when executing real engineering tasks.
