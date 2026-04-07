# 08. Deferred Tool Loading

## 1. Why This Matters

As the tool ecosystem grows (built-in tools + MCP servers + custom plugins), the system prompt balloons with tool descriptions. Each tool description costs 200-500 tokens. With 40+ tools, that is 8,000-20,000 tokens of tool descriptions in every LLM call — most of which the model will never use in a given turn.

Deferred tool loading solves this by including only tool names (not full descriptions) in the prompt for tools beyond a threshold, and providing a `ToolSearch` tool that loads full descriptions on demand.

## 2. Architecture

```
┌──────────────────────────────────────────────────┐
│ Tool Registry                                      │
│                                                    │
│ ┌──────────────────────────────────────────────┐  │
│ │ Always-Loaded Tools (built-in, <= THRESHOLD)  │  │
│ │                                                │  │
│ │ bash, read, edit, write, grep, glob,          │  │
│ │ question, task, memory-read, memory-write,    │  │
│ │ webfetch, websearch, toolsearch               │  │
│ │                                                │  │
│ │ → Full schema in system prompt                 │  │
│ └──────────────────────────────────────────────┘  │
│                                                    │
│ ┌──────────────────────────────────────────────┐  │
│ │ Deferred Tools (MCP + custom, > THRESHOLD)    │  │
│ │                                                │  │
│ │ mcp__github__create_pr                        │  │
│ │ mcp__slack__send_message                      │  │
│ │ plugin__deploy__trigger                       │  │
│ │ ...                                            │  │
│ │                                                │  │
│ │ → Name only in system prompt                   │  │
│ │ → Full schema loaded via ToolSearch            │  │
│ └──────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

## 3. Deferral Threshold

### 3.1 Constant

```typescript
const DEFER_THRESHOLD = 15
```

### 3.2 Rules

1. **Built-in tools** are ALWAYS loaded (never deferred), regardless of count
2. When total tool count exceeds `DEFER_THRESHOLD`, MCP and custom tools are deferred
3. Deferred tools appear in the system prompt as name-only entries:

```
The following deferred tools are available via ToolSearch:
- mcp__github__create_pr
- mcp__github__list_issues
- mcp__slack__send_message
- plugin__deploy__trigger
```

4. The `ToolSearch` tool itself is always loaded (it is a built-in tool)

## 4. ToolSearch Tool

### 4.1 Interface

```typescript
interface ToolSearchInput {
  query: string           // Search query
  max_results?: number    // Default: 5
}

interface ToolSearchResult {
  tools: ToolSchema[]     // Full schemas of matched tools
}
```

### 4.2 Query Syntax

The ToolSearch tool supports three query modes:

| Syntax | Example | Behavior |
|--------|---------|----------|
| `select:name1,name2` | `select:create_pr,list_issues` | Exact name match, fetch these specific tools |
| `keyword search` | `github pull request` | Fuzzy search across tool names and descriptions |
| `+prefix term` | `+github issue` | Require "github" in name, rank by "issue" |

### 4.3 Scoring Algorithm

```python
def score_tool(tool, query_terms, required_prefix=None):
    score = 0

    if required_prefix and required_prefix not in tool.name.lower():
        return -1  # Exclude

    for term in query_terms:
        # Name match (highest weight)
        if term in tool.name.lower():
            score += 3

        # Description match
        if tool.description and term in tool.description.lower():
            score += 1

        # Parameter name match
        for param in tool.parameters:
            if term in param.name.lower():
                score += 1

    return score
```

## 5. Session-Level Cache

### 5.1 Requirement

Once a tool's full schema is loaded via ToolSearch, it is cached for the remainder of the session. Subsequent calls to ToolSearch for the same tool return the cached schema without re-computation.

### 5.2 Pseudocode

```python
class ToolSearchCache:
    def __init__(self):
        self.loaded: dict[str, ToolSchema] = {}

    def get_or_load(self, tool_name: str) -> ToolSchema:
        if tool_name in self.loaded:
            return self.loaded[tool_name]

        schema = registry.get_full_schema(tool_name)
        if schema:
            self.loaded[tool_name] = schema
        return schema

    def is_loaded(self, tool_name: str) -> bool:
        return tool_name in self.loaded
```

### 5.3 Cache Integration with Prompt

Once a deferred tool is loaded into the cache, it becomes available for the model to call — subsequent LLM calls include the full schema:

```python
def build_tool_schemas(session):
    schemas = []

    # Always-loaded tools: full schema
    for tool in registry.builtin_tools:
        schemas.append(tool.full_schema())

    # Deferred tools: check cache
    for tool in registry.deferred_tools:
        if session.tool_cache.is_loaded(tool.name):
            schemas.append(tool.full_schema())
        # else: name-only, already in system prompt text

    return schemas
```

## 6. ToolSearch Implementation

```python
def toolsearch_execute(input):
    query = input.query
    max_results = input.max_results or 5

    # Mode 1: Direct selection
    if query.startswith("select:"):
        names = query[7:].split(",")
        results = []
        for name in names:
            name = name.strip()
            schema = session.tool_cache.get_or_load(name)
            if schema:
                results.append(schema)
        return ToolSearchResult(tools=results)

    # Mode 2: Prefix + keyword
    required_prefix = None
    terms = query.lower().split()
    if terms and terms[0].startswith("+"):
        required_prefix = terms[0][1:]
        terms = terms[1:]

    # Score all deferred tools
    scored = []
    for tool in registry.deferred_tools:
        score = score_tool(tool, terms, required_prefix)
        if score > 0:
            scored.append((score, tool))

    # Sort by score descending, take top N
    scored.sort(key=lambda x: -x[0])
    top = scored[:max_results]

    # Load into cache and return
    results = []
    for score, tool in top:
        schema = session.tool_cache.get_or_load(tool.name)
        results.append(schema)

    return ToolSearchResult(tools=results)
```

## 7. Token Savings Analysis

### 7.1 Calculation

Assume:
- 40 total tools
- 15 built-in (always loaded): ~150 tokens each = 2,250 tokens
- 25 MCP/custom tools: ~400 tokens each = 10,000 tokens

**Without deferred loading:**
```
Total tool tokens per call = 2,250 + 10,000 = 12,250 tokens
```

**With deferred loading:**
```
Built-in tools: 2,250 tokens (full schema)
Deferred tool names: 25 * 10 tokens = 250 tokens
Total = 2,500 tokens per call
Savings: ~78% reduction (9,750 tokens saved per call)
```

Even in the conservative case (only 20 deferred tools at 300 tokens each):
```
Savings: 6,000 tokens → 200 tokens = 67% reduction
```

## 8. Data Structures

```typescript
interface DeferredToolEntry {
  name: string
  source: "mcp" | "plugin" | "custom"
  serverName?: string        // MCP server name
  loaded: boolean            // Whether full schema is cached
}

interface ToolRegistry {
  builtinTools: ToolDefinition[]
  deferredTools: DeferredToolEntry[]
  totalCount: number
  deferredCount: number
}

interface ToolSearchScore {
  toolName: string
  score: number
  matchedTerms: string[]
}
```

## 9. Acceptance Criteria

- [ ] When total tools exceed DEFER_THRESHOLD (15), MCP/custom tools are deferred
- [ ] Built-in tools are never deferred regardless of total count
- [ ] Deferred tools appear as name-only in system prompt
- [ ] `ToolSearch` with `select:` syntax loads exact tools by name
- [ ] `ToolSearch` with keyword query returns ranked results
- [ ] `ToolSearch` with `+prefix` requires prefix match in tool name
- [ ] Loaded tool schemas are cached for the session duration
- [ ] Cached tools are included in subsequent LLM call tool schemas
- [ ] Token savings of 67-78% observed when 20+ tools are deferred

## 10. Source Files

| File | Responsibility |
|------|------|
| `src/tool/toolsearch.ts` | ToolSearch tool implementation, scoring algorithm |
| `src/tool/registry.ts` | Tool registry, deferral logic, session cache |
| `src/session/system.ts` | Deferred tool names in system prompt |
| `src/session/prompt.ts` | Include cached tool schemas in LLM call |

## 11. Product Manager Summary

> Tool count growth should not burden the system — deferred loading keeps the prompt lean while maintaining full tool availability on demand.
