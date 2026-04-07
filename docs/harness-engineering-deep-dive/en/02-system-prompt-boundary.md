# 02. System Prompt Dynamic Boundary

## 1. Why This Matters

The system prompt is sent with every LLM call. In a typical session with 30+ turns, a 4000-token system prompt costs 120,000 tokens — just for repeating the same instructions. Worse, the system prompt contains both fixed content (model instructions, safety constraints) and variable content (environment info, user preferences, MCP tool descriptions) that changes per turn.

Without separating these two layers, the entire prompt must be re-sent and re-processed on every call, wasting tokens and preventing caching optimizations.

## 2. Architecture: Static/Dynamic Split

```
┌─────────────────────────────────────────────────┐
│ System Prompt                                     │
│                                                   │
│ ┌─────────────────────────────────────────────┐  │
│ │ Static Layer (cacheable)                     │  │
│ │                                              │  │
│ │ - Model identity & behavior instructions     │  │
│ │ - Built-in tool guidance                     │  │
│ │ - Safety constraints & refusal rules         │  │
│ │ - Output format requirements                 │  │
│ │ - Code style guidelines                      │  │
│ │                                              │  │
│ │ cache_control: { type: "ephemeral" }         │  │
│ └─────────────────────────────────────────────┘  │
│                                                   │
│ ┌─────────────────────────────────────────────┐  │
│ │ Dynamic Layer (rebuilt each turn)            │  │
│ │                                              │  │
│ │ - Current working directory                  │  │
│ │ - OS / shell / platform info                 │  │
│ │ - User custom instructions (CLAUDE.md)       │  │
│ │ - Memory context (Phase 4)                   │  │
│ │ - MCP tool descriptions                      │  │
│ │ - Deferred tool names (Phase 7)              │  │
│ │ - Identity re-injection (Phase 3)            │  │
│ │ - Background task status (Phase 8)           │  │
│ └─────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## 3. Static Layer Design

### 3.1 Requirement

The static layer must be:
- Identical across all turns in a session
- Identical across all sessions using the same model
- Placed first in the system prompt array
- Tagged with `cache_control` for Anthropic providers

### 3.2 Content Categories

```typescript
interface StaticPromptSection {
  identity: string        // "You are Aboocode, an AI engineering assistant..."
  toolGuidance: string    // Built-in tool usage instructions
  safetyRules: string     // File safety, permission rules
  outputFormat: string    // Markdown, code block conventions
  codeStyle: string       // Language-specific conventions
}
```

### 3.3 Pseudocode

```python
def build_static_layer():
    sections = [
        load_template("identity.txt"),
        load_template("tool-guidance.txt"),
        load_template("safety-rules.txt"),
        load_template("output-format.txt"),
        load_template("code-style.txt"),
    ]
    return "\n\n".join(sections)
```

## 4. Dynamic Layer Design

### 4.1 Requirement

The dynamic layer is rebuilt before each LLM call. It must include all context that varies per turn:
- Environment state (cwd, platform, shell)
- User custom instructions from project config files
- Memory context loaded from the memory system
- MCP server tool descriptions (if connected)
- Deferred tool name list
- Post-compaction identity block (if applicable)
- Background task completion notifications

### 4.2 Pseudocode

```python
def build_dynamic_layer(session):
    parts = []

    # Environment
    parts.append(format_environment({
        cwd: session.cwd,
        platform: os.platform(),
        shell: os.shell(),
        date: today(),
    }))

    # User instructions
    instructions = load_user_instructions(session.cwd)
    if instructions:
        parts.append(format_instructions(instructions))

    # Memory context (Phase 4)
    memory = memory_context.load(session.cwd)
    if memory:
        parts.append(format_memory(memory))

    # MCP tools (deferred names only if Phase 7 active)
    mcp_tools = get_mcp_tool_descriptions(session)
    if mcp_tools:
        parts.append(format_mcp_tools(mcp_tools))

    # Identity re-injection (Phase 3)
    identity = get_post_compaction_identity(session.id)
    if identity:
        parts.append(format_identity_block(identity))

    # Background task notifications (Phase 8)
    completed = background.drain_completed(session.id)
    if completed:
        parts.append(format_task_completions(completed))

    return "\n\n".join(parts)
```

## 5. Provider-Specific Caching

### 5.1 Anthropic Provider

Anthropic's API supports `cache_control` on message parts. The static layer is tagged:

```typescript
function buildSystemPrompt(session: Session): SystemMessage[] {
  return [
    {
      type: "text",
      text: staticLayer,
      cache_control: { type: "ephemeral" }  // Anthropic cache hint
    },
    {
      type: "text",
      text: buildDynamicLayer(session)
    }
  ]
}
```

With `cache_control`, Anthropic caches the static prefix. Subsequent calls in the same session hit the cache, paying only 10% of the original token cost for the static portion.

### 5.2 Non-Anthropic Providers

For OpenAI, Google, and other providers, `cache_control` is not applicable. The system simply concatenates the static and dynamic layers into a single string:

```typescript
function buildSystemPromptGeneric(session: Session): string {
  return staticLayer + "\n\n---\n\n" + buildDynamicLayer(session)
}
```

The static layer still benefits from being deterministic — some providers (e.g., OpenAI) apply automatic prompt caching when the prefix matches.

### 5.3 Transform Layer

The provider transform layer handles the divergence:

```python
def transform_system_prompt(provider, static_text, dynamic_text):
    if provider.supports_cache_control:
        return [
            { text: static_text, cache_control: { type: "ephemeral" } },
            { text: dynamic_text }
        ]
    else:
        return static_text + "\n\n" + dynamic_text
```

## 6. Token Savings Analysis

### 6.1 Calculation

Assume:
- Static layer: 4,000 tokens
- Dynamic layer: 1,500 tokens (varies)
- Session length: 30 turns

**Without caching:**
```
Total system prompt tokens = 30 * (4000 + 1500) = 165,000 tokens
```

**With Anthropic caching (90% cache hit after turn 1):**
```
Turn 1: 4000 + 1500 = 5,500 (full)
Turns 2-30: 29 * (400 + 1500) = 55,100 (static = 10% cost)
Total = 5,500 + 55,100 = 60,600 tokens
Savings = 63%
```

**Over 10 calls with a 4000-token static layer:**
```
Without caching: 10 * 4000 = 40,000 static tokens
With caching: 4000 + 9 * 400 = 7,600 static tokens
Savings: ~36,000 tokens saved over 10 calls
```

## 7. Data Structures

```typescript
interface SystemPromptConfig {
  staticTemplatePaths: string[]    // Paths to static template files
  cacheStatic: boolean             // Enable caching (default: true)
  staticHash?: string              // Hash for cache invalidation
}

interface SystemPromptResult {
  static: string                   // Compiled static layer
  dynamic: string                  // Compiled dynamic layer
  totalTokenEstimate: number       // Estimated token count
}
```

## 8. Acceptance Criteria

- [ ] Static layer content is identical across consecutive LLM calls in the same session
- [ ] Dynamic layer is rebuilt before each LLM call
- [ ] Anthropic provider calls include `cache_control` on the static block
- [ ] Non-Anthropic providers concatenate static + dynamic without errors
- [ ] Adding a new MCP tool updates only the dynamic layer
- [ ] Changing model instructions updates only the static layer
- [ ] Token estimate correctly accounts for both layers
- [ ] Static layer hash changes when template files are modified

## 9. Source Files

| File | Responsibility |
|------|------|
| `src/session/system.ts` | Build static + dynamic layers, compile system prompt |
| `src/session/llm.ts` | Attach system prompt to LLM call |
| `src/provider/transform.ts` | Provider-specific cache_control injection |

## 10. Product Manager Summary

> The system prompt is a fixed cost for every LLM call — by splitting it into a cacheable static layer and an on-demand dynamic layer, the system dramatically reduces token consumption without sacrificing flexibility.
