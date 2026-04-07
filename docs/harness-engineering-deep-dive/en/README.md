# Aboocode Harness Engineering Deep-Dive (English)

In-depth analysis of the runtime governance architecture for AI coding agents.

This document set references Claude Code source and [ai-agent-deep-dive](https://github.com/tvytlx/ai-agent-deep-dive) product requirement specs, detailing the design rationale, implementation, and acceptance criteria for Aboocode's 13 Harness Engineering subsystems.

## Table of Contents

| # | Document | Topic |
|---|------|------|
| 00 | [Overview](./00-overview.md) | Product definition, architecture layers, Claude Code comparison |
| 01 | [Context Compression](./01-context-compression.md) | 3-layer compression model |
| 02 | [System Prompt Boundary](./02-system-prompt-boundary.md) | Static/dynamic split, caching |
| 03 | [Transcript Persistence](./03-transcript-persistence.md) | JSONL archival, audit & recovery |
| 04 | [Identity Re-injection](./04-identity-reinjection.md) | Agent role recovery after compaction |
| 05 | [Memory System](./05-memory-system.md) | 4 memory types, cross-session persistence |
| 06 | [Streaming Executor](./06-streaming-executor.md) | Concurrency classification, mutex gating |
| 07 | [Enhanced Hooks](./07-enhanced-hooks.md) | 7 hook types, blocking semantics |
| 08 | [Deferred Tool Loading](./08-deferred-tool-loading.md) | ToolSearch, on-demand activation |
| 09 | [Background Agents](./09-background-agents.md) | Non-blocking subtasks, notification queue |
| 10 | [Tool Governance](./10-tool-governance.md) | 8-step execution chain, telemetry |
| 11 | [Verification Agent](./11-verification-agent.md) | Read-only verification, PASS/FAIL reports |
| 12 | [Workspace Isolation](./12-workspace-isolation.md) | 5 isolation levels, least privilege |
| 13 | [Failure Recovery](./13-failure-recovery.md) | Error classification, 3-level recovery |

## Implementation Waves

```
Wave 1 (Foundation — parallelizable):
  Phase 0: 3-Layer Context Compression
  Phase 1: System Prompt Dynamic Boundary
  Phase 2: Transcript Persistence

Wave 2 (Core capabilities — parallelizable):
  Phase 3: Identity Re-injection
  Phase 5: Streaming Tool Executor
  Phase 6: Enhanced Hook System

Wave 3 (Persistence & Governance — parallelizable):
  Phase 4: Native Memory System
  Phase 9: Tool Governance Pipeline
  Phase 12: Failure Recovery Pipeline

Wave 4 (Advanced agent capabilities — parallelizable):
  Phase 7: Deferred Tool Loading
  Phase 8: Background Agent Execution
  Phase 11: Workspace Isolation Modes

Wave 5 (Capstone):
  Phase 10: Verification Agent
```

## License

MIT
