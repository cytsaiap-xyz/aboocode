# 09. 后台 Agent 执行需求文档

## 1. 为什么需要后台执行

子 Agent 任务（如代码搜索、测试运行、文档生成）可能耗时数秒到数分钟。如果主循环必须等待子 Agent 完成，用户只能盯着进度条。

后台执行允许：
- 主 Agent 继续与用户对话
- 子 Agent 在后台独立运行
- 完成后通过通知队列将结果送回主循环
- 主 Agent 在下一个 LLM 调用前拿到结果

## 2. 设计架构

```
┌────────────────────────────┐
│        主 Agent 循环        │
│                            │
│  1. 收到用户消息            │
│  2. drain() 获取后台结果    │
│  3. 构建提示词（含结果）     │
│  4. 调用 LLM               │
│  5. 执行工具调用            │
│     └─ 如果 run_in_background: │
│        register() → 立即返回 │
│  6. 返回响应                │
│                            │
│  循环 → 回到 2              │
└────────────────────────────┘
        ↕ 通知队列
┌────────────────────────────┐
│      后台任务池              │
│                            │
│  Task A: 运行中...          │
│  Task B: 已完成 ✓           │
│  Task C: 运行中...          │
└────────────────────────────┘
```

## 3. 数据结构

```typescript
export namespace BackgroundTasks {
  interface TaskEntry {
    id: string
    parentSessionID: string
    description: string
    promise: Promise<any>
    result?: any
    error?: string
    status: "running" | "completed" | "failed"
    startedAt: number
    completedAt?: number
  }

  // 注册后台任务
  function register(task: {
    id: string
    parentSessionID: string
    description: string
    promise: Promise<any>
  }): void

  // 获取已完成的任务（并清除）
  function drain(parentSessionID: string): TaskEntry[]

  // 获取所有任务状态
  function status(parentSessionID: string): TaskEntry[]
}
```

## 4. 触发方式

### 4.1 在 TaskTool 中添加 `run_in_background` 参数

```typescript
{
  name: "task",
  parameters: {
    description: string,
    prompt: string,
    agent?: string,
    run_in_background?: boolean,  // NEW
    isolation?: string
  }
}
```

当 `run_in_background: true` 时：
1. 创建子 Agent 会话
2. 启动 `SessionPrompt.prompt()` 但**不 await**
3. 将 Promise 注册到 `BackgroundTasks`
4. 立即返回 `"Task started in background. You will be notified when it completes."`

### 4.2 结果注入

在主循环的每次 LLM 调用前，调用 `BackgroundTasks.drain()` 获取已完成的后台任务，将结果作为合成消息注入：

```typescript
// prompt.ts — 每次 LLM 调用前
const completed = BackgroundTasks.drain(sessionID)
for (const task of completed) {
  messages.push({
    role: "user",
    content: `[Background task completed: "${task.description}"]
Status: ${task.status}
Result: ${task.result ?? task.error}`
  })
}
```

## 5. 伪代码

```python
class BackgroundTasks:
    tasks = {}  # parentSessionID -> [TaskEntry]

    def register(self, task):
        entry = TaskEntry(
            id=task.id,
            parent_session_id=task.parent_session_id,
            description=task.description,
            status="running",
            started_at=now()
        )

        async def run():
            try:
                result = await task.promise
                entry.result = result
                entry.status = "completed"
            except Exception as e:
                entry.error = str(e)
                entry.status = "failed"
            entry.completed_at = now()

        # 启动但不等待
        asyncio.create_task(run())
        self.tasks.setdefault(task.parent_session_id, []).append(entry)

    def drain(self, parent_session_id):
        entries = self.tasks.get(parent_session_id, [])
        completed = [e for e in entries if e.status in ("completed", "failed")]

        # 从列表中移除已完成的
        self.tasks[parent_session_id] = [
            e for e in entries if e.status == "running"
        ]

        return completed

    def status(self, parent_session_id):
        return self.tasks.get(parent_session_id, [])
```

## 6. 典型用法

### 6.1 模型视角

```
User: 帮我重构这个模块，同时跑一下测试套件

Model:
  1. [tool: task] description="运行测试套件" run_in_background=true
     → "Task started in background."
  2. [tool: read] path="src/module.ts"
     → 开始重构工作...

# 几个 turn 后，测试完成
[Background task completed: "运行测试套件"]
Status: completed
Result: 42 tests passed, 0 failed

Model: 测试全部通过，重构可以安全继续。
```

### 6.2 用户视角

用户看到主 Agent 在重构代码的同时，后台任务的进度信息在 TUI 中实时更新。当后台任务完成时，主 Agent 自动获知结果并作出反应。

## 7. 与其他 Phase 的交互

| Phase | 交互方式 |
|-------|---------|
| Phase 5 (Executor) | 后台任务创建使用独立的 executor 实例 |
| Phase 11 (Isolation) | 后台任务默认使用 `worktree` 隔离模式 |
| Phase 10 (Verify) | 验证 Agent 可以作为后台任务运行 |

## 8. 验收标准

- [ ] `run_in_background: true` 的任务立即返回
- [ ] 主 Agent 循环不被后台任务阻塞
- [ ] 后台任务完成后，结果在下一次 LLM 调用前注入
- [ ] 后台任务失败时，错误信息正确传递
- [ ] 多个后台任务可以并行运行
- [ ] `drain()` 只返回自上次调用后新完成的任务

## 9. 源码位置

| 文件 | 职责 |
|------|------|
| `src/session/background.ts` | BackgroundTasks 命名空间 |
| `src/tool/task.ts` | `run_in_background` 参数处理 |
| `src/session/prompt.ts` | 每次 LLM 调用前 drain 结果 |

## 10. 产品经理视角下的总需求句

> 等待是最差的用户体验——后台执行让子 Agent 任务与主循环并行，模型可以"派出去做"然后继续对话，完成后自动获得结果，像一个能同时处理多件事的工程师而不是只能排队执行的脚本。
