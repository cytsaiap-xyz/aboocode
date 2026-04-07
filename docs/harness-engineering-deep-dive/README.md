# Aboocode Harness Engineering Deep-Dive

面向 AI 编程 Agent 的运行时治理架构深度解析。

本文档集参考 Claude Code 源码和 [ai-agent-deep-dive](https://github.com/tvytlx/ai-agent-deep-dive) 产品需求规范，详细描述 Aboocode 的 13 个 Harness Engineering 子系统的设计思路、实现方案和验收标准。

## 目录

| # | 文档 | 主题 |
|---|------|------|
| 00 | [总览](./00-overview.md) | 产品定义、架构分层、与 Claude Code 对比 |
| 01 | [三层上下文压缩](./01-context-compression.md) | Micro-Compact / Proactive / Reactive 三层压缩模型 |
| 02 | [系统提示词动态边界](./02-system-prompt-boundary.md) | 静态/动态分层、Provider-agnostic 缓存策略 |
| 03 | [会话全文持久化](./03-transcript-persistence.md) | JSONL 存档、压缩前保存、审计与恢复 |
| 04 | [压缩后身份重注入](./04-identity-reinjection.md) | Agent 角色恢复、工作目录保持、无缝续接 |
| 05 | [原生记忆系统](./05-memory-system.md) | 四种记忆类型、跨会话持久化、Markdown 存储 |
| 06 | [流式工具执行器](./06-streaming-executor.md) | 并发安全分类、Mutex 门控、兄弟中止 |
| 07 | [增强 Hook 系统](./07-enhanced-hooks.md) | 7 种 Hook 类型、阻断语义、插件治理 |
| 08 | [延迟工具加载](./08-deferred-tool-loading.md) | ToolSearch、按需激活、Token 节省 |
| 09 | [后台 Agent 执行](./09-background-agents.md) | 非阻塞子任务、通知队列、结果注入 |
| 10 | [工具治理管线](./10-tool-governance.md) | 8 步执行链、自定义校验器、Telemetry |
| 11 | [独立验证 Agent](./11-verification-agent.md) | 只读验证、对抗性检查、PASS/FAIL 报告 |
| 12 | [工作区隔离模式](./12-workspace-isolation.md) | 五级隔离、最小权限、Worktree 隔离 |
| 13 | [失败恢复管线](./13-failure-recovery.md) | 错误分类、三级恢复、自动续写 |

## 实现波次

```
Wave 1 (基础层 — 可并行):
  Phase 0: 三层上下文压缩
  Phase 1: 系统提示词动态边界
  Phase 2: 会话全文持久化

Wave 2 (核心能力 — 可并行):
  Phase 3: 压缩后身份重注入
  Phase 5: 流式工具执行器
  Phase 6: 增强 Hook 系统

Wave 3 (持久化与治理 — 可并行):
  Phase 4: 原生记忆系统
  Phase 9: 工具治理管线
  Phase 12: 失败恢复管线

Wave 4 (高级 Agent 能力 — 可并行):
  Phase 7: 延迟工具加载
  Phase 8: 后台 Agent 执行
  Phase 11: 工作区隔离模式

Wave 5 (顶层):
  Phase 10: 独立验证 Agent
```

## 许可证

MIT
