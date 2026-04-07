# Aboocode Harness Engineering 深度解析（繁體中文）

面向 AI 編程 Agent 的運行時治理架構深度解析。

本文檔集參考 Claude Code 原始碼和 [ai-agent-deep-dive](https://github.com/tvytlx/ai-agent-deep-dive) 產品需求規範，詳細描述 Aboocode 的 13 個 Harness Engineering 子系統的設計思路、實作方案和驗收標準。

## 目錄

| # | 文檔 | 主題 |
|---|------|------|
| 00 | [總覽](./00-overview.md) | 產品定義、架構分層、與 Claude Code 對比 |
| 01 | [三層上下文壓縮](./01-context-compression.md) | Micro-Compact / Proactive / Reactive 三層壓縮模型 |
| 02 | [系統提示詞動態邊界](./02-system-prompt-boundary.md) | 靜態/動態分層、Provider 無關快取策略 |
| 03 | [會話全文持久化](./03-transcript-persistence.md) | JSONL 存檔、審計與恢復 |
| 04 | [壓縮後身份重注入](./04-identity-reinjection.md) | Agent 角色恢復、無縫續接 |
| 05 | [原生記憶系統](./05-memory-system.md) | 四種記憶類型、跨會話持久化 |
| 06 | [流式工具執行器](./06-streaming-executor.md) | 並發安全分類、Mutex 門控 |
| 07 | [增強 Hook 系統](./07-enhanced-hooks.md) | 七種 Hook 類型、阻斷語義 |
| 08 | [延遲工具載入](./08-deferred-tool-loading.md) | ToolSearch、按需啟動 |
| 09 | [後台 Agent 執行](./09-background-agents.md) | 非阻塞子任務、通知佇列 |
| 10 | [工具治理管線](./10-tool-governance.md) | 八步執行鏈、遙測記錄 |
| 11 | [獨立驗證 Agent](./11-verification-agent.md) | 唯讀驗證、結構化報告 |
| 12 | [工作區隔離模式](./12-workspace-isolation.md) | 五級隔離、最小權限 |
| 13 | [失敗恢復管線](./13-failure-recovery.md) | 錯誤分類、三級恢復 |

## 實作波次

```
Wave 1（基礎層 — 可並行）:
  Phase 0: 三層上下文壓縮
  Phase 1: 系統提示詞動態邊界
  Phase 2: 會話全文持久化

Wave 2（核心能力 — 可並行）:
  Phase 3: 壓縮後身份重注入
  Phase 5: 流式工具執行器
  Phase 6: 增強 Hook 系統

Wave 3（持久化與治理 — 可並行）:
  Phase 4: 原生記憶系統
  Phase 9: 工具治理管線
  Phase 12: 失敗恢復管線

Wave 4（高級 Agent 能力 — 可並行）:
  Phase 7: 延遲工具載入
  Phase 8: 後台 Agent 執行
  Phase 11: 工作區隔離模式

Wave 5（頂層）:
  Phase 10: 獨立驗證 Agent
```

## 授權

MIT
