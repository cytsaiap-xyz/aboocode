# 08. 延迟工具加载需求文档

## 1. 为什么需要延迟加载

每个工具在系统提示词中占用 token：工具名称、描述、参数 schema。一个典型工具占 200-500 tokens。

当用户启用了多个 MCP Server（Playwright、GitHub、Memory 等），工具数量轻松超过 50 个。50 个工具 × 300 tokens = 15,000 tokens 的系统提示词——这还没算指令和记忆。

更关键的是：大部分工具在大部分会话中不会被使用。用户说"帮我改个 Bug"时，不需要 Playwright 的 30 个浏览器操作工具。

## 2. 解决方案：ToolSearch

### 2.1 核心思路

- 内置工具（read、write、bash、grep 等）**始终加载**——它们是高频核心工具
- MCP 工具和自定义工具默认**延迟加载**——只列出名称，不包含完整 schema
- 模型需要使用某个延迟工具时，调用 `ToolSearch` 获取完整 schema
- 获取后的工具在当前会话内缓存，后续无需再搜索

### 2.2 阈值

```typescript
const DEFER_THRESHOLD = 15
```

当注册的工具总数 > 15 时，启用延迟加载。MCP 工具和 custom 工具被标记为 deferred。

## 3. ToolSearch 工具定义

```typescript
{
  name: "toolsearch",
  description: "搜索可用工具的完整定义。用于查找和激活延迟加载的工具。",
  parameters: {
    query: string  // 搜索查询
    max_results?: number  // 最大结果数，默认 5
  }
}
```

### 3.1 查询语法

- `"select:read,edit,grep"` — 精确选择指定工具
- `"browser navigate"` — 关键词搜索
- `"+playwright screenshot"` — 要求名称包含 "playwright"

### 3.2 搜索算法

```python
def search(query, deferred_tools, max_results=5):
    if query.startswith("select:"):
        names = query[7:].split(",")
        return [t for t in deferred_tools if t.name in names]

    require_prefix = None
    terms = query.split()
    if terms[0].startswith("+"):
        require_prefix = terms[0][1:]
        terms = terms[1:]

    scores = []
    for tool in deferred_tools:
        score = 0
        text = f"{tool.name} {tool.description}".lower()

        if require_prefix and require_prefix not in tool.name:
            continue

        for term in terms:
            if term in tool.name:
                score += 3  # 名称匹配权重高
            elif term in text:
                score += 1

        if score > 0:
            scores.append((tool, score))

    scores.sort(key=lambda x: -x[1])
    return [t for t, s in scores[:max_results]]
```

## 4. 系统提示词中的延迟工具

在动态层中列出延迟工具的名称：

```
The following deferred tools are available via ToolSearch:
mcp__playwright__browser_click
mcp__playwright__browser_navigate
mcp__playwright__browser_screenshot
mcp__github__create_pull_request
mcp__github__list_issues
...

Use the toolsearch tool to get their full definitions before calling them.
```

## 5. 会话级缓存

```typescript
const sessionToolCache = new Map<string, Map<string, Tool.Info>>()

function activateTool(sessionID: string, tool: Tool.Info) {
  if (!sessionToolCache.has(sessionID)) {
    sessionToolCache.set(sessionID, new Map())
  }
  sessionToolCache.get(sessionID)!.set(tool.name, tool)
}

function getActivatedTools(sessionID: string): Tool.Info[] {
  return Array.from(sessionToolCache.get(sessionID)?.values() ?? [])
}
```

一旦通过 ToolSearch 激活，工具在整个会话期间保持可用，不需要重复搜索。

## 6. 伪代码：完整流程

```python
def build_tool_list(session_id, all_tools):
    if len(all_tools) <= DEFER_THRESHOLD:
        return all_tools  # 不延迟加载

    eager = [t for t in all_tools if t.is_builtin]
    deferred = [t for t in all_tools if not t.is_builtin]
    activated = get_activated_tools(session_id)

    return eager + activated, deferred

# 当模型调用 ToolSearch
def handle_toolsearch(query, session_id, deferred_tools):
    results = search(query, deferred_tools)
    for tool in results:
        activate_tool(session_id, tool)
    return format_tool_schemas(results)
```

## 7. Token 节省效果

| 场景 | 无延迟加载 | 有延迟加载 | 节省 |
|------|-----------|-----------|------|
| 15 个内置 + 40 个 MCP 工具 | ~16,500 tokens | ~5,500 tokens | ~67% |
| 15 个内置 + 100 个 MCP 工具 | ~34,500 tokens | ~7,500 tokens | ~78% |

## 8. 验收标准

- [ ] 工具总数 <= 15 时，所有工具直接加载
- [ ] 工具总数 > 15 时，MCP 工具只显示名称
- [ ] ToolSearch 返回完整的 JSON Schema 定义
- [ ] 激活后的工具在后续 turn 中可直接使用
- [ ] `select:name1,name2` 语法正确返回指定工具
- [ ] 关键词搜索按相关性排序

## 9. 源码位置

| 文件 | 职责 |
|------|------|
| `src/tool/toolsearch.ts` | ToolSearch 命名空间 + 搜索算法 |
| `src/tool/registry.ts` | 注册 ToolSearchTool |
| `src/session/system.ts` | 动态层列出延迟工具名称 |
| `src/session/prompt.ts` | 构建工具列表时区分 eager/deferred |

## 10. 产品经理视角下的总需求句

> 工具数量的增长不应该成为系统负担——通过延迟加载，系统提示词只包含核心工具和工具名称清单，模型按需搜索并激活所需的工具，既节省了 token 成本，又保持了完整的工具可用性。
