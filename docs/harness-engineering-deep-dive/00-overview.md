# 00. Aboocode Harness Engineering 总览

## 1. 什么是 Harness Engineering

Harness Engineering 是指围绕大语言模型构建的运行时治理架构。它不是模型本身的能力，而是模型之外的系统工程——包括上下文管理、工具执行链、权限治理、任务调度、记忆持久化、失败恢复等一系列基础设施。

Aboocode 的 Harness Engineering 参考了 Claude Code 的泄露源码和 ai-agent-deep-dive 产品需求规范，在保持 provider-agnostic（提供者无关）的前提下，实现了 13 个核心子系统。

## 2. 为什么需要 Harness Engineering

### 2.1 模型能力的边界

大语言模型可以推理、生成代码、理解自然语言，但它：
- 没有持久记忆
- 没有执行环境感知
- 没有权限概念
- 没有任务追踪能力
- 会在长对话中丢失上下文
- 无法自我验证

### 2.2 简单 Agent 的不足

简单 Agent（模型 + 工具调用循环）的问题：
- 上下文无限膨胀，直到 token 溢出
- 工具调用无治理，模型可以做任何事
- 单次对话结束后知识全部丢失
- 无法分解复杂任务
- 出错后不知道如何恢复
- 无法并发执行独立操作

### 2.3 Aboocode 的解决方案

Aboocode 通过 13 个 Harness Phase 将"模型 + 工具"升级为一个可控、可扩展、可产品化的 AI 工程执行系统：

```
Phase  0: 三层上下文压缩（Micro-Compaction）
Phase  1: 系统提示词动态边界（System Prompt Boundary）
Phase  2: 会话全文持久化（Transcript Persistence）
Phase  3: 压缩后身份重注入（Identity Re-injection）
Phase  4: 原生记忆系统（Native Memory System）
Phase  5: 流式工具执行器（Streaming Tool Executor）
Phase  6: 增强 Hook 系统（Enhanced Hook System）
Phase  7: 延迟工具加载（Deferred Tool Loading）
Phase  8: 后台 Agent 执行（Background Agent Execution）
Phase  9: 工具治理管线（Tool Governance Pipeline）
Phase 10: 独立验证 Agent（Verification Agent）
Phase 11: 工作区隔离模式（Workspace Isolation）
Phase 12: 失败恢复管线（Failure Recovery Pipeline）
```

## 3. 架构分层

```
┌──────────────────────────────────────────────┐
│            用户交互层 (TUI / CLI)              │
├──────────────────────────────────────────────┤
│         会话管理层 (Session / Prompt)          │
│  ┌─────────┬──────────┬───────────────────┐  │
│  │ 压缩引擎 │ 恢复管线  │   身份注入         │  │
│  │ Phase 0  │ Phase 12 │   Phase 3         │  │
│  └─────────┴──────────┴───────────────────┘  │
├──────────────────────────────────────────────┤
│         工具执行层 (Tool Execution)            │
│  ┌─────────┬──────────┬───────────────────┐  │
│  │ 治理管线 │ 并发执行  │   延迟加载         │  │
│  │ Phase 9  │ Phase 5  │   Phase 7         │  │
│  └─────────┴──────────┴───────────────────┘  │
├──────────────────────────────────────────────┤
│         Agent 调度层 (Agent Orchestration)     │
│  ┌─────────┬──────────┬───────────────────┐  │
│  │ 后台执行 │ 验证Agent │   工作区隔离       │  │
│  │ Phase 8  │ Phase 10 │   Phase 11        │  │
│  └─────────┴──────────┴───────────────────┘  │
├──────────────────────────────────────────────┤
│         持久化层 (Persistence)                 │
│  ┌─────────┬──────────┬───────────────────┐  │
│  │ 记忆系统 │ 全文存档  │   系统提示词缓存   │  │
│  │ Phase 4  │ Phase 2  │   Phase 1         │  │
│  └─────────┴──────────┴───────────────────┘  │
├──────────────────────────────────────────────┤
│         扩展层 (Extensibility)                 │
│  ┌──────────────────────────────────────────┐│
│  │  Plugin / Hook / MCP — Phase 6           ││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

## 4. 与 Claude Code 的对比

| 能力 | Claude Code | Aboocode | 差异 |
|------|------------|----------|------|
| 上下文压缩 | 三层（micro + proactive + reactive） | 三层（同构实现） | 一致 |
| 系统提示词缓存 | Anthropic cache_control | Provider-agnostic 分段 | Aboocode 支持任意 Provider |
| 会话存档 | 内部存储 | JSONL 本地文件 | Aboocode 可离线查阅 |
| 记忆系统 | 文件型 Markdown | 文件型 Markdown | 基本一致 |
| 工具并发 | 并发安全标记 | Mutex + 队列 | 实现方式不同，目标一致 |
| 工具治理 | 8 步执行链 | 8 步执行链 | 一致 |
| 延迟加载 | ToolSearch | ToolSearch | 一致 |
| 验证 Agent | 无独立验证 | 独立只读验证 Agent | Aboocode 更强 |
| 工作区隔离 | worktree 模式 | 5 级隔离模式 | Aboocode 更细粒度 |
| 失败恢复 | 基础重试 | 分类恢复管线 | Aboocode 更完善 |

## 5. 技术栈

- **运行时**: Bun
- **语言**: TypeScript
- **AI SDK**: Vercel AI SDK（provider-agnostic）
- **数据库**: SQLite（via Drizzle ORM）
- **TUI**: Ink（React for CLI）
- **插件系统**: 自研 Plugin namespace

## 6. 产品经理视角下的总需求句

> Aboocode 的 Harness Engineering 不是在模型上面包一层壳，而是构建了一套完整的运行时治理架构——让 AI 在执行真实工程任务时，能够管理上下文、治理工具、持久记忆、分解任务、隔离风险、自动恢复，并且可被独立验证。
