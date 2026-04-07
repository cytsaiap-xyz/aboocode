# 07. 增强 Hook 系统需求文档

## 1. 为什么 Hook 是治理的基础

Hook 机制让外部规则可以介入运行时行为。没有 Hook，系统的行为完全由硬编码逻辑决定。有了 Hook：
- 组织可以注入安全策略
- 插件可以修改输入输出
- 用户可以定制行为而不修改源码

## 2. Hook 清单

### 2.1 工具生命周期 Hook

| Hook 名称 | 触发时机 | 能力 |
|-----------|---------|------|
| `tool.execute.before` | 工具执行前 | 修改参数、阻断执行、注入上下文 |
| `tool.execute.after` | 工具执行后 | 修改结果、记录审计、触发通知 |
| `tool.permission.check` | 权限决策前 | 返回 allow/deny/ask 覆盖默认策略 |

### 2.2 会话生命周期 Hook

| Hook 名称 | 触发时机 | 能力 |
|-----------|---------|------|
| `session.start` | 会话循环开始 | 初始化、日志记录 |
| `session.end` | 会话循环结束 | 清理、分析、统计 |

### 2.3 用户交互 Hook

| Hook 名称 | 触发时机 | 能力 |
|-----------|---------|------|
| `prompt.submit` | 用户消息处理前 | 修改文本、取消提交 |
| `turn.stop` | 模型 turn 结束后 | 阻止停止、注入继续指令 |

## 3. Hook 执行模型

### 3.1 串行执行

所有 Hook 按注册顺序串行执行。前一个 Hook 的输出是后一个的输入。

### 3.2 阻断语义

如果任何 Hook 返回 `blocked: true`：
- 后续 Hook 不执行
- 工具调用不执行
- 阻断原因返回给模型作为工具结果

### 3.3 修改语义

Hook 可以修改输入参数（pre-hook）或输出结果（post-hook）。修改后的值传递给下一个 Hook 或工具执行。

## 4. 数据结构

```typescript
interface Hooks {
  // 工具 Hooks
  "tool.execute.before": {
    info: { tool: string; sessionID: string; callID: string }
    input: { args: any }
    output: { args: any; blocked?: boolean; blockReason?: string }
  }
  "tool.execute.after": {
    info: { tool: string; sessionID: string; callID: string; args: any }
    input: any  // 工具执行结果
    output: any // 可修改的结果
  }
  "tool.permission.check": {
    info: { tool: string; sessionID: string; args: any }
    input: { decision: "allow" | "ask" | "deny" }
    output: { decision: "allow" | "ask" | "deny"; reason?: string }
  }

  // 会话 Hooks
  "session.start": {
    info: { sessionID: string; agent: string }
    input: {}
    output: {}
  }
  "session.end": {
    info: { sessionID: string; agent: string; turns: number }
    input: {}
    output: {}
  }

  // 交互 Hooks
  "prompt.submit": {
    info: { sessionID: string }
    input: { text: string }
    output: { text: string; cancelled?: boolean }
  }
  "turn.stop": {
    info: { sessionID: string; reason: string }
    input: { shouldStop: boolean }
    output: { shouldStop: boolean; continuePrompt?: string }
  }
}
```

## 5. 插件注册 Hook

```typescript
// 插件示例：阻止删除操作
Plugin.register({
  name: "no-delete-guard",
  hooks: {
    "tool.execute.before": async (info, input) => {
      if (info.tool === "bash" && input.args.command?.includes("rm -rf")) {
        return {
          args: input.args,
          blocked: true,
          blockReason: "rm -rf 操作被安全策略阻止"
        }
      }
      return input
    }
  }
})
```

## 6. 伪代码

```python
async def trigger_hook(hook_name, info, initial_value):
    """触发所有注册在 hook_name 上的处理器"""
    handlers = get_handlers(hook_name)
    value = initial_value

    for handler in handlers:
        value = await handler(info, value)

        # 检查阻断
        if hasattr(value, 'blocked') and value.blocked:
            return value

    return value

# 在工具执行链中使用
async def execute_tool_with_hooks(tool, args, ctx):
    # Pre-hook
    pre_result = await trigger_hook(
        "tool.execute.before",
        {"tool": tool.name, "sessionID": ctx.session_id, "callID": ctx.call_id},
        {"args": args}
    )

    if pre_result.get("blocked"):
        return blocked_result(pre_result["blockReason"])

    modified_args = pre_result["args"]

    # 执行
    result = await tool.execute(modified_args, ctx)

    # Post-hook
    final_result = await trigger_hook(
        "tool.execute.after",
        {"tool": tool.name, "sessionID": ctx.session_id, "callID": ctx.call_id, "args": modified_args},
        result
    )

    return final_result
```

## 7. 与其他 Phase 的交互

| Phase | 交互方式 |
|-------|---------|
| Phase 9 (Governance) | 治理管线在步骤 4/8 调用 pre/post hooks |
| Phase 6 本身 | 所有 hook 通过 Plugin.trigger() 统一执行 |
| Phase 12 (Recovery) | `turn.stop` hook 可以实现 max-output 续写 |

## 8. 验收标准

- [ ] `tool.execute.before` hook 能修改工具参数
- [ ] `tool.execute.before` hook 能阻断工具执行
- [ ] `tool.execute.after` hook 能修改工具结果
- [ ] `tool.permission.check` hook 能覆盖权限决策
- [ ] `session.start` / `session.end` hook 在正确时机触发
- [ ] `prompt.submit` hook 能修改用户输入文本
- [ ] `turn.stop` hook 能阻止 turn 结束并注入续写提示
- [ ] 多个 Hook 按注册顺序串行执行

## 9. 源码位置

| 文件 | 职责 |
|------|------|
| `packages/plugin/src/index.ts` | Hooks 接口定义 + Plugin.trigger() |
| `src/plugin/index.ts` | 各触发点的 Hook 调用 |
| `src/session/prompt.ts` | session/prompt/turn hooks 触发 |
| `src/tool/governance.ts` | tool hooks 触发 |

## 10. 产品经理视角下的总需求句

> Hook 是系统从"封闭产品"变成"可治理平台"的关键——它让组织安全策略、用户偏好、插件行为都能在运行时介入工具执行和会话流程，而不需要修改一行核心代码。
