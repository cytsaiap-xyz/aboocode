# 01. 三层上下文压缩需求文档

## 1. 为什么上下文管理是最高优先级

大语言模型的上下文窗口是有限资源。一个典型的工程会话可能涉及数十次工具调用，每次返回数百行结果。如果不主动管理，上下文会在 10-20 个工具调用后溢出，导致：
- API 报错中断
- 模型丢失任务上下文
- 费用暴涨

Claude Code 的核心优势之一就是三层压缩策略——Aboocode 完整复现了这一架构。

## 2. 三层压缩模型

```
┌─────────────────────────────────────────┐
│ 第一层: Micro-Compact（微压缩）          │
│ 触发: 每次 LLM 调用前                    │
│ 行为: 清除旧工具结果，保留最近 N 次       │
│ 代价: 零（不调用 LLM）                   │
├─────────────────────────────────────────┤
│ 第二层: Proactive Compact（主动压缩）     │
│ 触发: token 使用量 >= 80% 阈值           │
│ 行为: 调用 LLM 生成摘要替换历史消息       │
│ 代价: 一次 LLM 调用                      │
├─────────────────────────────────────────┤
│ 第三层: Reactive Compact（反应式压缩）    │
│ 触发: token 使用量 >= 95% 或 API 溢出报错 │
│ 行为: 紧急压缩 + 重建上下文               │
│ 代价: 一次 LLM 调用 + 可能丢失细节        │
└─────────────────────────────────────────┘
```

## 3. 第一层：Micro-Compact

### 3.1 需求

在每次调用 LLM 之前，系统必须自动清除旧的工具执行结果，只保留最近 N 次（默认 5 次）。被清除的结果替换为占位文本 `[Old tool result content cleared]`。

### 3.2 可压缩工具列表

并非所有工具结果都可以安全清除。以下工具的历史结果可以被微压缩：

```typescript
const MICRO_COMPACTABLE_TOOLS = new Set([
  "bash", "read", "grep", "glob",
  "edit", "write", "webfetch", "websearch"
])
```

以下工具结果**不可**被压缩（它们对后续推理有持续作用）：
- `task`（任务状态）
- `question`（用户回答）
- `skill`（技能输出）
- `memory-read` / `memory-write`

### 3.3 伪代码

```python
def micro_compact(session_id, keep_recent=5):
    messages = get_messages(session_id)
    tool_count = 0

    # 从最新消息向旧消息遍历
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

### 3.4 效果

微压缩可以在不调用 LLM 的情况下，将上下文使用量降低 40-60%。这意味着：
- 在需要主动压缩之前，用户可以多执行 2-3 倍的工具调用
- 压缩是零成本的（不消耗 token）
- 模型仍然能看到最近 5 次工具的完整结果

## 4. 第二层：Proactive Compact

### 4.1 需求

当 token 使用量达到上下文窗口的 80% 时，系统触发主动压缩：
1. 保存完整会话到磁盘（Phase 2 Transcript）
2. 调用 LLM 将历史消息摘要为一条 summary
3. 用 summary 替换旧消息
4. 注入身份上下文（Phase 3 Identity）

### 4.2 伪代码

```python
def proactive_compact(session_id):
    state = token_budget.get_state(session_id)
    if state.current_estimate < state.compact_threshold:
        return

    messages = get_messages(session_id)

    # Phase 2: 保存全文
    transcript.save(session_id, messages)

    # 调用 LLM 生成摘要
    summary = llm.summarize(messages, system_prompt="请将以下对话摘要为简洁的工作进度描述...")

    # 替换历史消息
    replace_messages(session_id, [summary_message(summary)])

    # Phase 3: 标记需要身份重注入
    set_post_compaction(session_id, {
        agent: current_agent,
        cwd: current_working_directory
    })
```

## 5. 第三层：Reactive Compact

### 5.1 需求

当模型 API 返回 `prompt_too_long` 错误时，系统不应该停止，而应该：
1. 立即触发微压缩（更激进：`keep_recent=2`）
2. 如果仍然超限，触发主动压缩
3. 压缩完成后自动重试当前 turn

### 5.2 与 Phase 12 的关系

反应式压缩是 Phase 12（失败恢复管线）的一个特例。当 `processor.ts` 捕获到 `prompt_too_long` 错误时：

```python
def handle_prompt_too_long(session_id):
    # 尝试微压缩
    micro_compact(session_id, keep_recent=2)
    state = recalculate_budget(session_id)

    if state.still_over_limit:
        proactive_compact(session_id)

    # 自动重试
    return Transition.Continue
```

## 6. Token Budget 计算

### 6.1 核心公式

```
maxOutput = min(model.limit.output, 16384)
rawMaxInput = model.limit.input ?? (model.limit.context - maxOutput)
maxInput = max(rawMaxInput, 0)  // 零值保护

compactThreshold = maxInput * 0.8
reactiveThreshold = maxInput * 0.95
```

### 6.2 零值保护

**关键经验教训**：如果模型配置缺少 `limit.context`（例如自定义 provider），`rawMaxInput` 会变成负数，导致压缩阈值为负，每条消息都会触发压缩。

修复方案：
```typescript
const maxInput = rawMaxInput > 0 ? rawMaxInput : 0

export function shouldCompact(state: State): boolean {
  if (state.maxInputTokens <= 0) return false  // 安全守卫
  return state.currentEstimate >= state.compactThreshold
}
```

## 7. 验收标准

- [ ] 发送 10+ 次工具调用后，旧的工具结果显示 `[Old tool result content cleared]`
- [ ] 微压缩不调用任何 LLM API
- [ ] token 使用量达到 80% 时自动触发主动压缩
- [ ] API 报错 `prompt_too_long` 时自动恢复而非崩溃
- [ ] 模型配置缺少 `limit` 字段时不会触发无限压缩循环
- [ ] 压缩前完整会话已保存到磁盘

## 8. 源码位置

| 文件 | 职责 |
|------|------|
| `src/session/compaction.ts` | 微压缩 + 主动压缩逻辑 |
| `src/session/token-budget.ts` | Token 预算计算 + 阈值 |
| `src/session/prompt.ts` | 每次 LLM 调用前触发微压缩 |
| `src/session/processor.ts` | 反应式压缩（捕获 API 错误） |

## 9. 产品经理视角下的总需求句

> 上下文不是无限的——系统必须像操作系统管理内存一样管理 token：能省则省（微压缩），该压则压（主动压缩），出错能救（反应式压缩），并且绝不能因为配置缺失而陷入无限循环。
