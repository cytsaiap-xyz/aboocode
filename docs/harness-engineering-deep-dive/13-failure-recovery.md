# 13. 失败恢复管线需求文档

## 1. 为什么需要分级恢复

Agent 运行中的错误类型多样：
- 工具输入格式错误
- 用户拒绝权限
- 上下文溢出
- 模型 API 限流
- 模型输出截断
- 网络超时

简单的"重试或停止"策略无法有效处理这些场景。有些错误只需调整输入，有些需要压缩上下文，有些需要完全重建。

## 2. 失败分类

| 失败类型 | 原因 | 严重级别 | 恢复策略 |
|---------|------|---------|---------|
| `tool_input_error` | 模型生成了无效参数 | Light | 返回错误给模型，让它修正 |
| `permission_denied` | 用户拒绝了操作 | Light | 引导模型换一种方式 |
| `hook_blocked` | 插件阻断了操作 | Light | 返回阻断原因 |
| `prompt_too_long` | 上下文溢出 | Medium | 触发反应式压缩 |
| `max_output_tokens` | 模型输出被截断 | Medium | 注入"继续"提示 |
| `model_api_error` | API 返回错误 | Medium-Heavy | 指数退避重试 |
| `model_overloaded` | 服务器过载 | Medium | 等待 + 重试 |
| `catastrophic` | 不可恢复的错误 | Heavy | 保存 Transcript + 通知用户 |

## 3. 三级恢复

### 3.1 Light Recovery（轻量恢复）

不改变上下文状态，只调整当前 turn：

```python
def light_recovery(error, ctx):
    if error.type == "tool_input_error":
        # 将错误作为工具结果返回给模型
        return ToolResult(
            error=True,
            content=f"Tool input error: {error.message}. Please fix and retry."
        )

    elif error.type == "permission_denied":
        return ToolResult(
            error=True,
            content=f"Permission denied. Consider an alternative approach."
        )

    elif error.type == "hook_blocked":
        return ToolResult(
            error=True,
            content=f"Blocked by policy: {error.reason}"
        )

    return Transition.Continue
```

### 3.2 Medium Recovery（中等恢复）

需要修改上下文状态：

```python
def medium_recovery(error, session_id, ctx):
    if error.type == "prompt_too_long":
        # 先尝试激进微压缩
        micro_compact(session_id, keep_recent=2)
        state = recalculate_budget(session_id)

        if state.still_over_limit:
            # 触发完整压缩
            await proactive_compact(session_id)

        return Transition.Continue  # 自动重试

    elif error.type == "max_output_tokens":
        # 注入"继续"提示
        if ctx.continue_count < MAX_CONTINUES:
            inject_message(session_id, {
                "role": "user",
                "content": "Output limit hit. Continue exactly where you left off."
            })
            ctx.continue_count += 1
            return Transition.Continue
        else:
            return Transition.Terminal("Max continues exceeded")

    elif error.type == "model_overloaded":
        delay = min(2 ** ctx.retry_count * 1000, 30000)  # 指数退避，最长 30s
        await sleep(delay)
        ctx.retry_count += 1
        if ctx.retry_count > 5:
            return Transition.Terminal("Model overloaded after 5 retries")
        return Transition.Continue
```

### 3.3 Heavy Recovery（重度恢复）

需要保存状态并可能重建：

```python
def heavy_recovery(error, session_id, ctx):
    # 保存完整 Transcript
    transcript.save(session_id, get_messages(session_id))

    if error.type == "catastrophic":
        # 通知用户
        notify_user(
            f"An unrecoverable error occurred. "
            f"Your conversation has been saved to: {transcript_path}"
        )
        return Transition.Terminal(error.message)

    # 尝试从 Transcript 重建
    summary = get_compaction_summary(session_id)
    recent = get_recent_messages(session_id, count=3)

    rebuild_session(session_id, [summary] + recent)
    return Transition.Continue
```

## 4. Max Output Token 续写

### 4.1 问题

模型在生成长输出时可能触及 `max_output_tokens` 限制，输出被截断。这在生成大文件或长解释时常见。

### 4.2 解决方案

当检测到输出因 token 限制而截断（`finish_reason === "length"`）：

1. 保留截断的输出作为 assistant 消息
2. 注入 synthetic user 消息：`"Output limit hit. Continue exactly where you left off."`
3. 让模型继续生成
4. 最多续写 3 次

```python
MAX_CONTINUES = 3

def handle_output_truncation(session_id, truncated_output, continue_count):
    if continue_count >= MAX_CONTINUES:
        log.warn("Max continues reached, stopping")
        return Transition.Terminal("Output too long")

    # 保留截断输出
    append_message(session_id, {
        "role": "assistant",
        "content": truncated_output
    })

    # 注入续写提示
    append_message(session_id, {
        "role": "user",
        "content": "Output limit hit. Continue exactly where you left off."
    })

    return Transition.Continue
```

## 5. 恢复决策流程

```
错误发生
  │
  ├─ tool_input_error → Light: 返回错误给模型
  ├─ permission_denied → Light: 引导替代方案
  ├─ hook_blocked → Light: 返回阻断原因
  ├─ prompt_too_long → Medium: 微压缩 → 主动压缩 → 重试
  ├─ max_output_tokens → Medium: 注入续写提示（≤3次）
  ├─ model_overloaded → Medium: 指数退避重试（≤5次）
  ├─ model_api_error → Medium: 退避重试 → Heavy: 保存 + 通知
  └─ catastrophic → Heavy: 保存 Transcript + 终止
```

## 6. 与其他 Phase 的交互

| Phase | 交互方式 |
|-------|---------|
| Phase 0 (Compression) | prompt_too_long 触发反应式压缩 |
| Phase 2 (Transcript) | Heavy Recovery 保存 Transcript |
| Phase 6 (Hooks) | `turn.stop` hook 可以阻止终止 |
| Phase 9 (Governance) | 工具错误经过 Telemetry 记录 |

## 7. 伪代码：统一恢复入口

```python
async def classify_and_recover(error, session_id, ctx):
    """统一错误分类和恢复入口"""
    error_type = classify_error(error)

    log.info("recovery:classify", type=error_type, error=str(error))

    if error_type in ("tool_input_error", "permission_denied", "hook_blocked"):
        return light_recovery(error_type, error, ctx)

    elif error_type in ("prompt_too_long", "max_output_tokens", "model_overloaded"):
        return await medium_recovery(error_type, error, session_id, ctx)

    elif error_type in ("model_api_error",):
        result = await medium_recovery(error_type, error, session_id, ctx)
        if result == Transition.Terminal:
            return await heavy_recovery(error, session_id, ctx)
        return result

    else:
        return await heavy_recovery(error, session_id, ctx)

def classify_error(error):
    """根据错误信息分类"""
    msg = str(error).lower()

    if "validation" in msg or "invalid" in msg:
        return "tool_input_error"
    elif "permission" in msg or "denied" in msg:
        return "permission_denied"
    elif "blocked" in msg:
        return "hook_blocked"
    elif "too long" in msg or "context" in msg or "token" in msg:
        return "prompt_too_long"
    elif "max_tokens" in msg or "length" in msg:
        return "max_output_tokens"
    elif "overloaded" in msg or "529" in msg:
        return "model_overloaded"
    elif "rate" in msg or "429" in msg:
        return "model_overloaded"
    else:
        return "model_api_error"
```

## 8. 验收标准

- [ ] tool_input_error 返回格式化的错误给模型
- [ ] prompt_too_long 触发反应式压缩而不是崩溃
- [ ] max_output_tokens 自动注入续写提示（最多 3 次）
- [ ] model_overloaded 使用指数退避重试
- [ ] 不可恢复错误保存 Transcript 并通知用户
- [ ] 所有恢复操作都有日志记录
- [ ] 每种错误类型映射到正确的恢复级别

## 9. 源码位置

| 文件 | 职责 |
|------|------|
| `src/session/recovery.ts` | Recovery 命名空间（分类 + 恢复策略） |
| `src/session/processor.ts` | 错误捕获，调用 recovery |
| `src/session/compaction.ts` | 反应式压缩（prompt_too_long） |
| `src/session/prompt.ts` | 续写提示注入 |

## 10. 产品经理视角下的总需求句

> 错误不是终点而是决策点——系统必须能够分类错误、选择恢复策略、自动执行恢复，让大部分错误在用户无感知的情况下被自动处理，只有真正不可恢复的情况才中断并通知用户。
