# 03. 会话全文持久化需求文档

## 1. 为什么需要全文持久化

当压缩（Compaction）触发时，系统会将历史消息替换为摘要。这意味着原始对话——包括完整的工具输入输出、模型的推理过程、错误信息——全部永久丢失。

这带来三个问题：
1. **不可审计**：无法回溯"模型为什么做了这个决定"
2. **不可恢复**：如果摘要丢失关键信息，无法从原始对话恢复
3. **不可学习**：无法分析历史会话中的模式和问题

## 2. 设计方案

### 2.1 存储格式：JSONL

每条消息存为一行 JSON，便于流式写入和按行读取：

```
{"role":"user","content":"请修复登录Bug","timestamp":1712534400000}
{"role":"assistant","content":"我来看看代码...","timestamp":1712534401000}
{"role":"assistant","tool_calls":[{"name":"read","args":{"path":"auth.ts"}}],"timestamp":1712534402000}
{"role":"tool","name":"read","content":"export function login()...","timestamp":1712534403000}
```

### 2.2 存储路径

```
~/.local/share/aboocode/transcripts/{sessionID}/{timestamp}.jsonl
```

- 每次压缩产生一个新的 JSONL 文件
- 文件名使用 ISO 时间戳，便于排序
- 按 sessionID 分目录，避免单目录文件过多

### 2.3 写入时机

Transcript 保存发生在 Compaction 的**最开始**——在 LLM 摘要调用之前。这确保即使摘要过程失败，原始对话已经安全保存。

## 3. 数据结构

```typescript
export namespace Transcript {
  export interface Entry {
    role: string
    content?: string
    tool_calls?: any[]
    tool_name?: string
    timestamp: number
    metadata?: Record<string, any>
  }

  export async function save(input: {
    sessionID: string
    messages: Message[]
  }): Promise<string>  // 返回文件路径

  export async function load(
    path: string
  ): Promise<Entry[]>

  export async function list(
    sessionID: string
  ): Promise<{ path: string; timestamp: number }[]>
}
```

## 4. 伪代码

```python
def save_transcript(session_id, messages):
    dir = f"{data_dir}/transcripts/{session_id}"
    ensure_dir(dir)

    timestamp = datetime.now().isoformat()
    path = f"{dir}/{timestamp}.jsonl"

    with open(path, "w") as f:
        for msg in messages:
            entry = serialize_message(msg)
            f.write(json.dumps(entry) + "\n")

    log.info("transcript:saved", path=path, count=len(messages))
    return path

def load_transcript(path):
    entries = []
    with open(path, "r") as f:
        for line in f:
            entries.append(json.loads(line))
    return entries

def list_transcripts(session_id):
    dir = f"{data_dir}/transcripts/{session_id}"
    files = sorted(glob(f"{dir}/*.jsonl"), reverse=True)
    return [
        {"path": f, "timestamp": parse_timestamp(f)}
        for f in files
    ]
```

## 5. 与其他 Phase 的交互

| Phase | 交互方式 |
|-------|---------|
| Phase 0 (Compaction) | 在主动压缩开始前调用 `Transcript.save()` |
| Phase 12 (Recovery) | Heavy Recovery 可以从 Transcript 重建上下文 |
| Phase 9 (Governance) | Telemetry 记录引用 Transcript 路径 |

## 6. 容量管理

### 6.1 单文件大小

一个典型的 100 turn 会话，JSONL 文件约 200-500KB。不需要压缩。

### 6.2 清理策略

目前不做自动清理。未来可以考虑：
- 保留最近 30 天的 Transcript
- 超过 100MB 总量时提醒用户
- 用户可手动删除 `~/.local/share/aboocode/transcripts/` 目录

## 7. 验收标准

- [ ] 每次 Compaction 前，完整消息已保存为 JSONL 文件
- [ ] JSONL 文件可以被正确解析回消息列表
- [ ] `Transcript.list()` 返回的结果按时间降序排列
- [ ] Transcript 目录不存在时自动创建
- [ ] 写入失败不阻断 Compaction 流程（降级为 warning）

## 8. 源码位置

| 文件 | 职责 |
|------|------|
| `src/session/transcript.ts` | Transcript 命名空间（save/load/list） |
| `src/session/compaction.ts` | 在 `process()` 开头调用 `Transcript.save()` |

## 9. 产品经理视角下的总需求句

> 压缩是必要的，但丢失原始对话是不可接受的——系统必须在压缩前将完整会话存档到磁盘，既保证上下文窗口可控，又保留审计和恢复的能力。
