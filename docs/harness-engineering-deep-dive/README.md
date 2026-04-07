# Aboocode Harness Engineering Deep-Dive

In-depth analysis of the runtime governance architecture for AI coding agents.

面向 AI 編程 Agent 的運行時治理架構深度解析。

## Languages / 語言版本

- **[English](./en/)** — Full documentation in English
- **[繁體中文](./zh-TW/)** — 完整繁體中文文檔

Both versions cover the same 13 Harness Engineering subsystems (Phase 0–12), with pseudocode, acceptance criteria, source file references, and product manager summaries.

兩個版本涵蓋相同的 13 個 Harness Engineering 子系統（Phase 0–12），包含偽代碼、驗收標準、原始碼位置和產品經理總結。

## Phases

| # | Phase | Description |
|---|-------|-------------|
| 0 | Context Compression | 3-layer: micro-compact, proactive, reactive |
| 1 | System Prompt Boundary | Static/dynamic split with provider-agnostic caching |
| 2 | Transcript Persistence | JSONL archival before compaction |
| 3 | Identity Re-injection | Agent role recovery after compaction |
| 4 | Memory System | 4 memory types, cross-session persistence |
| 5 | Streaming Executor | Concurrent-safe tool parallelization with mutex |
| 6 | Enhanced Hooks | 7 hook types for runtime governance |
| 7 | Deferred Tool Loading | ToolSearch for on-demand tool activation |
| 8 | Background Agents | Non-blocking subtask execution |
| 9 | Tool Governance | 8-step auditable execution pipeline |
| 10 | Verification Agent | Independent read-only verification |
| 11 | Workspace Isolation | 5-level isolation modes |
| 12 | Failure Recovery | Classified 3-tier error recovery |

## License

MIT
