# 05. 原生记忆系统需求文档

## 1. 为什么需要跨会话记忆

每次会话结束，所有上下文消失。模型不知道：
- 用户是谁（角色、偏好、技能水平）
- 用户给过什么反馈（"不要这样做"、"保持简洁"）
- 项目的背景信息（截止日期、架构决策、团队约定）
- 重要资源在哪里（Linear 项目、Grafana 面板、CI 地址）

如果没有记忆系统，用户必须在每次新会话重复提供这些信息。

## 2. 记忆类型

### 2.1 四种记忆类型

| 类型 | 描述 | 保存时机 | 使用场景 |
|------|------|---------|---------|
| `user` | 用户角色、目标、偏好 | 了解到用户身份信息时 | 调整交互风格和建议 |
| `feedback` | 用户对工作方式的反馈 | 用户纠正或确认非显而易见的做法时 | 避免重复犯错 |
| `project` | 项目动态、决策、计划 | 了解到项目状态时 | 提供上下文感知的建议 |
| `reference` | 外部资源的位置和用途 | 了解到外部系统信息时 | 知道去哪里找信息 |

### 2.2 不应该保存的内容

- 代码结构和架构（从代码中读取）
- Git 历史（从 git log 中获取）
- 调试方案（修复已在代码中）
- CLAUDE.md 已有的内容
- 临时任务状态

## 3. 存储架构

### 3.1 目录结构

```
~/.config/aboocode/projects/{sanitized-cwd}/memory/
├── MEMORY.md           # 索引文件（始终加载到上下文）
├── user_role.md        # 具体记忆文件
├── feedback_testing.md
├── project_deadline.md
└── reference_ci.md
```

### 3.2 记忆文件格式

```markdown
---
name: 用户角色
description: 用户是资深后端工程师，首次接触 React
type: user
---

用户有 10 年 Go 开发经验，但这是第一次接触本项目的 React 前端。
解释前端概念时应使用后端类比。
```

### 3.3 索引文件（MEMORY.md）

```markdown
- [用户角色](user_role.md) — 资深后端，新学 React
- [测试偏好](feedback_testing.md) — 集成测试必须用真实数据库
- [发版冻结](project_deadline.md) — 2026-03-05 后冻结非关键合并
```

限制：最多 200 行、25KB。索引始终注入到系统提示词动态层。

## 4. 记忆工具

### 4.1 MemoryWriteTool

```typescript
{
  name: "memory-write",
  description: "保存或更新一条记忆",
  parameters: {
    filename: string,    // 文件名（不含路径）
    name: string,        // 记忆名称
    description: string, // 一行描述
    type: "user" | "feedback" | "project" | "reference",
    content: string      // 记忆内容
  }
}
```

行为：
1. 写入记忆文件（带 frontmatter）
2. 更新 MEMORY.md 索引
3. 如果文件已存在，覆盖更新

### 4.2 MemoryReadTool

```typescript
{
  name: "memory-read",
  description: "读取记忆索引或具体记忆文件",
  parameters: {
    filename?: string  // 不指定则读取 MEMORY.md
  }
}
```

## 5. 系统提示词注入

在动态层中，记忆系统注入以下内容：

```
# Memory

You have a persistent memory system. The index below shows all saved memories:

[MEMORY.md 内容]

Use memory-read to access specific memories.
Use memory-write to save new observations.
Save memories when you learn about:
- The user's role, preferences, or expertise
- Feedback about your work approach
- Project decisions, deadlines, or constraints
- Locations of external resources
```

## 6. Feedback 类型的特殊处理

Feedback 记忆是最重要的类型，因为它直接影响行为：

### 6.1 结构

```markdown
---
name: 不要在测试中 mock 数据库
description: 集成测试必须连接真实数据库
type: feedback
---

集成测试必须使用真实数据库，不能 mock。

**Why:** 上个季度 mock 测试全部通过但生产环境迁移失败。

**How to apply:** 当编写或修改测试时，始终配置真实数据库连接。
```

### 6.2 双向记录

不仅记录纠正（"不要这样做"），也记录确认（"是的，就是这样"）。只记录纠正会让模型变得过于保守。

## 7. 伪代码

```python
def memory_write(filename, name, description, type, content):
    dir = get_memory_dir(current_project)
    path = f"{dir}/{filename}"

    # 写入记忆文件
    frontmatter = f"---\nname: {name}\ndescription: {description}\ntype: {type}\n---\n\n"
    write_file(path, frontmatter + content)

    # 更新索引
    index_path = f"{dir}/MEMORY.md"
    index = read_file(index_path) or ""
    entry = f"- [{name}]({filename}) — {description[:100]}"

    if filename in index:
        # 替换已有条目
        index = replace_line_containing(index, filename, entry)
    else:
        index += "\n" + entry

    write_file(index_path, index)

def build_memory_prompt(project):
    dir = get_memory_dir(project)
    index_path = f"{dir}/MEMORY.md"
    if not exists(index_path):
        return None

    content = read_file(index_path)
    return MEMORY_INSTRUCTIONS + "\n\n" + content
```

## 8. 验收标准

- [ ] `memory-write` 创建带 frontmatter 的 markdown 文件
- [ ] `memory-write` 同步更新 MEMORY.md 索引
- [ ] `memory-read` 无参数时返回 MEMORY.md 内容
- [ ] `memory-read` 带文件名时返回具体记忆内容
- [ ] MEMORY.md 内容出现在系统提示词中
- [ ] 新会话能读取上一个会话保存的记忆
- [ ] 记忆目录不存在时自动创建

## 9. 源码位置

| 文件 | 职责 |
|------|------|
| `src/memory/memory.ts` | Memory 命名空间核心逻辑 |
| `src/memory/context.ts` | 构建记忆提示词注入内容 |
| `src/tool/memory-read.ts` | MemoryReadTool 定义 |
| `src/tool/memory-write.ts` | MemoryWriteTool 定义 |
| `src/session/system.ts` | 动态层注入记忆提示词 |

## 10. 产品经理视角下的总需求句

> 一个不记得用户是谁、不记得之前犯过什么错的 AI 助手，每次都像初次见面——记忆系统让 Aboocode 能够跨会话积累对用户、项目和工作方式的理解，真正成为长期协作伙伴。
