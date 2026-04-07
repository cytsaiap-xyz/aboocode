# 06. 流式工具执行器需求文档

## 1. 为什么需要并发工具执行

当模型在一个 turn 中返回多个工具调用时（例如同时读 3 个文件），顺序执行意味着：
- 读 file1: 200ms
- 读 file2: 200ms
- 读 file3: 200ms
- 总耗时: 600ms

如果并发执行：
- 读 file1 + file2 + file3: ~200ms
- 总耗时: 200ms

对于涉及网络请求的工具（webfetch、websearch），差异更明显——从秒级降到亚秒级。

但并非所有工具都可以安全并发。写文件和执行 shell 命令之间可能有依赖关系，必须互斥执行。

## 2. 并发安全分类

### 2.1 可并发工具（concurrent-safe）

这些工具只读取状态，不修改文件系统：

```typescript
const CONCURRENT_SAFE = [
  "read",       // 读文件
  "grep",       // 搜索内容
  "glob",       // 搜索文件
  "websearch",  // 网络搜索
  "webfetch",   // 获取网页
  "question",   // 用户提问
  "memory-read", // 读记忆
  "codesearch", // 代码搜索
  "toolsearch", // 工具搜索
]
```

### 2.2 互斥工具（non-concurrent）

这些工具修改文件系统或有副作用：

```typescript
const NON_CONCURRENT = [
  "bash",       // Shell 命令（可能改变任何状态）
  "edit",       // 编辑文件
  "write",      // 写文件
  "apply_patch", // 应用补丁
  "task",       // 创建子任务
  "memory-write", // 写记忆
]
```

## 3. Mutex 门控模型

```
┌──────────────────────────────────────────┐
│           StreamingExecutor               │
│                                          │
│  状态: IDLE / CONCURRENT / EXCLUSIVE      │
│                                          │
│  IDLE:                                   │
│    任何工具都可以进入                       │
│                                          │
│  CONCURRENT:                             │
│    concurrent-safe 工具可以并行进入        │
│    non-concurrent 工具排队等待            │
│                                          │
│  EXCLUSIVE:                              │
│    只有一个 non-concurrent 工具在执行      │
│    所有其他工具排队等待                     │
└──────────────────────────────────────────┘
```

## 4. 数据结构

```typescript
export namespace StreamingExecutor {
  interface Executor {
    gate(toolId: string, isConcurrencySafe: boolean): Promise<void>
    release(toolId: string): void
    abortSiblings(errorToolId: string): void
  }

  export function create(): Executor {
    let state: "idle" | "concurrent" | "exclusive" = "idle"
    let activeCount = 0
    const queue: Array<{
      resolve: () => void
      toolId: string
      concurrent: boolean
    }> = []

    return { gate, release, abortSiblings }
  }
}
```

## 5. 伪代码

```python
class StreamingExecutor:
    state = "idle"
    active_count = 0
    queue = []

    async def gate(self, tool_id, is_concurrent_safe):
        if self.state == "idle":
            if is_concurrent_safe:
                self.state = "concurrent"
            else:
                self.state = "exclusive"
            self.active_count = 1
            return

        if self.state == "concurrent" and is_concurrent_safe:
            self.active_count += 1
            return

        # 需要排队
        future = Future()
        self.queue.append({
            "resolve": future.set_result,
            "tool_id": tool_id,
            "concurrent": is_concurrent_safe
        })
        await future

    def release(self, tool_id):
        self.active_count -= 1
        if self.active_count > 0:
            return

        self.state = "idle"
        self._drain_queue()

    def _drain_queue(self):
        if not self.queue:
            return

        next_item = self.queue[0]
        if next_item["concurrent"]:
            # 释放所有排队的 concurrent 工具
            self.state = "concurrent"
            while self.queue and self.queue[0]["concurrent"]:
                item = self.queue.pop(0)
                self.active_count += 1
                item["resolve"](None)
        else:
            # 释放一个 exclusive 工具
            item = self.queue.pop(0)
            self.state = "exclusive"
            self.active_count = 1
            item["resolve"](None)

    def abort_siblings(self, error_tool_id):
        """当 bash 命令出错时，取消正在排队的兄弟工具"""
        for item in self.queue:
            item["resolve"](AbortError())
        self.queue.clear()
```

## 6. 集成到工具执行链

在 `prompt.ts` 的 `resolveTools()` 中，对每个工具的 `execute` 回调进行包装：

```typescript
// prompt.ts
const executor = StreamingExecutor.create()

function wrapExecute(tool: Tool.Info, originalExecute: Function) {
  return async (args: any, options: any) => {
    await executor.gate(tool.id, tool.isConcurrencySafe ?? true)
    try {
      return await originalExecute(args, options)
    } finally {
      executor.release(tool.id)
    }
  }
}
```

## 7. Bash 错误的兄弟中止

当一个 bash 命令失败时（退出码非零），模型通常期望后续操作基于 bash 的输出。如果此时有并发的 read/grep 仍在执行，它们的结果已经无意义。

`abortSiblings()` 可以取消所有排队中的工具，让模型更快地看到错误并做出反应。

## 8. 验收标准

- [ ] 3 个并发的 read 调用总耗时 ≈ 单次 read 耗时（非 3 倍）
- [ ] write + read 同时触发时，read 等待 write 完成后执行
- [ ] 两个 bash 命令不会并行执行
- [ ] bash 失败后排队的工具被正确中止
- [ ] 工具声明中包含 `isConcurrencySafe` 字段

## 9. 源码位置

| 文件 | 职责 |
|------|------|
| `src/session/executor.ts` | StreamingExecutor 命名空间 |
| `src/tool/tool.ts` | `Tool.Info.isConcurrencySafe` 字段 |
| `src/session/prompt.ts` | 包装 execute 回调 |

## 10. 产品经理视角下的总需求句

> 模型一次返回多个工具调用不是意外而是常态——系统必须在保证安全的前提下尽可能并行执行，用 mutex 门控区分可并发的只读操作和需要互斥的写操作，让用户不必为顺序等待买单。
