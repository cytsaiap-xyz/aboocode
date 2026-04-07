# 04. 压缩后身份重注入需求文档

## 1. 为什么压缩后需要身份重注入

当主动压缩（Proactive Compact）触发后，所有历史消息被替换为一条摘要。模型在下一次调用时只能看到：
- 系统提示词
- 摘要消息
- 最新用户消息

问题是：模型可能会忘记自己的角色定位和当前任务上下文。表现为：
- 压缩后模型突然变得"客气"，开始自我介绍
- 忘记当前工作目录
- 丢失 agent 类型信息（比如 build agent vs explore agent）
- 重复已完成的工作

## 2. 设计方案

### 2.1 身份上下文结构

```typescript
interface IdentityContext {
  agent: string        // 当前 agent 名称
  description?: string // agent 描述
  cwd: string          // 当前工作目录
  postCompaction: true  // 标记
}
```

### 2.2 注入流程

```
压缩完成
  → 保存 IdentityContext 到内存映射
  → 下一次构建系统提示词时检测到 postCompaction=true
  → 在动态层末尾追加身份块
  → LLM 调用成功后清除 postCompaction 标记
```

### 2.3 身份块格式

```xml
<identity>
You are "build", an AI coding agent working in /Users/dev/myproject.
Context was compressed. The summary above contains your previous work.
Continue with the task described in the summary. Do not re-introduce yourself.
</identity>
```

## 3. 伪代码

```python
# compaction.ts — 压缩完成后
post_compaction_state = {}

def set_post_compaction(session_id, ctx):
    post_compaction_state[session_id] = {
        "agent": ctx.agent,
        "description": ctx.description,
        "cwd": ctx.cwd,
        "postCompaction": True
    }

def get_post_compaction(session_id):
    return post_compaction_state.get(session_id)

def clear_post_compaction(session_id):
    del post_compaction_state[session_id]

def build_identity_prompt(session_id):
    ctx = get_post_compaction(session_id)
    if not ctx:
        return None

    return f"""<identity>
You are "{ctx.agent}", working in {ctx.cwd}.
Context was compressed. The summary above contains your previous work.
Continue with the task described in the summary.
</identity>"""

# prompt.ts — 构建系统提示词时
identity = build_identity_prompt(session_id)
if identity:
    system_sections.append({"text": identity, "scope": "session"})
    # LLM 调用成功后
    clear_post_compaction(session_id)
```

## 4. 为什么不在摘要中包含身份

替代方案是让摘要 LLM 在生成摘要时包含身份信息。但这有两个问题：
1. 摘要 LLM 可能不会可靠地保留身份信息
2. 身份信息应该是**确定性的**（从配置读取），而不是**生成性的**（依赖 LLM 输出）

## 5. 与其他 Phase 的交互

| Phase | 交互方式 |
|-------|---------|
| Phase 0 (Compaction) | 压缩完成后触发身份保存 |
| Phase 1 (Prompt Boundary) | 身份块注入到动态层 |
| Phase 4 (Memory) | 记忆内容补充长期身份上下文 |

## 6. 验收标准

- [ ] 压缩后的第一次 LLM 调用，系统提示词包含 `<identity>` 块
- [ ] `<identity>` 块包含正确的 agent 名称和工作目录
- [ ] LLM 调用成功后，`<identity>` 块不再出现
- [ ] 压缩后模型不会重新自我介绍
- [ ] 多 session 并发时，身份上下文不会串台

## 7. 源码位置

| 文件 | 职责 |
|------|------|
| `src/session/compaction.ts` | `setPostCompaction()` / `getPostCompaction()` / `buildIdentityPrompt()` |
| `src/session/prompt.ts` | 注入身份块 + 成功后清除 |

## 8. 产品经理视角下的总需求句

> 压缩不应该让模型失忆——系统必须在压缩后主动将身份和任务上下文重新注入，确保模型无缝继续工作而不是从头开始。
