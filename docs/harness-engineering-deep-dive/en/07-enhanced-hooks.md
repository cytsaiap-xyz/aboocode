# 07. Enhanced Hook System

## 1. Why This Matters

A closed AI agent is limited to its built-in behaviors. Organizations need to enforce security policies, users want to customize workflows, and plugin developers need extension points. Without hooks, every customization requires forking the codebase.

The enhanced hook system provides 7 lifecycle hooks with blocking and modification semantics, transforming Aboocode from a closed product into a governable, extensible platform.

## 2. Seven Hook Types

```
Session Lifecycle:
  ┌──────────┐     ┌──────────┐
  │ session.  │     │ session. │
  │ start     │ ... │ end      │
  └────┬─────┘     └──────────┘
       │
       ▼
Turn Lifecycle:
  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
  │ prompt.       │───▶│ tool.execute │───▶│ turn.stop    │
  │ submit        │    │ (per tool)   │    │              │
  └──────────────┘    └──────┬───────┘    └──────────────┘
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
             ┌───────────┐    ┌───────────┐
             │ tool.      │    │ tool.     │
             │ permission │    │ execute.  │
             │ .check     │    │ after     │
             └───────────┘    └───────────┘
```

### 2.1 Hook Definitions

| Hook | Trigger | Can Block | Can Modify |
|------|---------|-----------|------------|
| `session.start` | Session initialization | No | Session config |
| `session.end` | Session termination | No | Cleanup actions |
| `prompt.submit` | Before user message sent to LLM | Yes | Message content |
| `tool.permission.check` | Before permission resolution | Yes | Permission decision |
| `tool.execute.before` | Before tool execution | Yes | Tool arguments |
| `tool.execute.after` | After tool execution | No | Tool result |
| `turn.stop` | After LLM turn completes | No | Continue decision |

## 3. Hook Execution Semantics

### 3.1 Serial Execution

All hooks for a given event execute serially, in registration order. This ensures deterministic behavior and allows later hooks to see modifications from earlier hooks.

```
Hook A (plugin-1) → Hook B (plugin-2) → Hook C (plugin-3)
     │                    │                    │
     ▼                    ▼                    ▼
  Modifies args      Sees modified args   Sees further modified args
```

### 3.2 Blocking Semantics

Hooks that return `{ blocked: true }` stop the chain:

```python
def run_hooks(event, context):
    for hook in get_hooks(event):
        result = hook.handler(context)

        if result and result.get("blocked"):
            return HookResult(
                blocked=True,
                reason=result.get("reason", "Blocked by hook"),
                blockedBy=hook.plugin_name,
            )

        if result and result.get("modified"):
            context = merge(context, result.modified)

    return HookResult(blocked=False, context=context)
```

When a pre-hook blocks:
- `tool.execute.before` → tool is NOT executed; error returned to model
- `tool.permission.check` → permission denied; model informed
- `prompt.submit` → message is NOT sent to LLM; user informed

### 3.3 Modification Semantics

- **Pre-hooks** (`tool.execute.before`, `prompt.submit`) can modify the input:
  - `tool.execute.before` can rewrite tool arguments
  - `prompt.submit` can rewrite the user message

- **Post-hooks** (`tool.execute.after`) can modify the output:
  - `tool.execute.after` can filter, transform, or annotate tool results

## 4. Hook Interface

### 4.1 Data Structures

```typescript
interface HookRegistration {
  event: HookEvent
  handler: HookHandler
  pluginName: string
  priority?: number        // Lower = runs first (default: 100)
}

type HookEvent =
  | "session.start"
  | "session.end"
  | "prompt.submit"
  | "tool.permission.check"
  | "tool.execute.before"
  | "tool.execute.after"
  | "turn.stop"

type HookHandler = (context: HookContext) => Promise<HookHandlerResult | void>

interface HookContext {
  sessionId: string
  event: HookEvent
  data: Record<string, unknown>  // Event-specific payload
}

interface HookHandlerResult {
  blocked?: boolean
  reason?: string
  modified?: Record<string, unknown>
}
```

### 4.2 Event-Specific Payloads

```typescript
// tool.execute.before
interface ToolExecuteBeforeData {
  toolName: string
  args: Record<string, unknown>
  callId: string
}

// tool.execute.after
interface ToolExecuteAfterData {
  toolName: string
  args: Record<string, unknown>
  result: ToolResult
  durationMs: number
}

// tool.permission.check
interface ToolPermissionCheckData {
  toolName: string
  args: Record<string, unknown>
  currentPermission: PermissionLevel
}

// prompt.submit
interface PromptSubmitData {
  message: string
  attachments?: Attachment[]
}

// turn.stop
interface TurnStopData {
  reason: "end_turn" | "max_tokens" | "tool_use"
  messageCount: number
  tokensUsed: number
}
```

## 5. Plugin Registration Example

### 5.1 Security Policy Plugin

```typescript
// Plugin: Deny all bash commands containing 'rm -rf /'
export default function securityPlugin(api: PluginAPI) {
  api.hook("tool.execute.before", async (context) => {
    const { toolName, args } = context.data as ToolExecuteBeforeData

    if (toolName === "bash" && typeof args.command === "string") {
      if (args.command.includes("rm -rf /")) {
        return {
          blocked: true,
          reason: "Destructive command blocked by security policy",
        }
      }
    }
  })
}
```

### 5.2 Logging Plugin

```typescript
// Plugin: Log all tool executions with timing
export default function loggingPlugin(api: PluginAPI) {
  api.hook("tool.execute.after", async (context) => {
    const { toolName, durationMs, result } = context.data as ToolExecuteAfterData
    console.log(`[TOOL] ${toolName} completed in ${durationMs}ms`)

    // Optionally modify result to add metadata
    return {
      modified: {
        result: {
          ...result,
          metadata: { ...result.metadata, loggedAt: new Date().toISOString() }
        }
      }
    }
  })
}
```

### 5.3 Auto-Format Plugin

```typescript
// Plugin: Auto-format files after write/edit
export default function autoFormatPlugin(api: PluginAPI) {
  api.hook("tool.execute.after", async (context) => {
    const { toolName, args } = context.data as ToolExecuteAfterData

    if (toolName === "write" || toolName === "edit") {
      const filePath = args.file_path as string
      if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
        await exec(`prettier --write "${filePath}"`)
      }
    }
  })
}
```

## 6. Pseudocode: Hook Engine

```python
class HookEngine:
    def __init__(self):
        self.hooks: dict[str, list[HookRegistration]] = {}

    def register(self, registration: HookRegistration):
        event = registration.event
        if event not in self.hooks:
            self.hooks[event] = []
        self.hooks[event].append(registration)
        # Sort by priority (lower = first)
        self.hooks[event].sort(key=lambda h: h.priority or 100)

    async def fire(self, event: str, data: dict) -> HookResult:
        hooks = self.hooks.get(event, [])
        context = HookContext(
            sessionId=current_session_id(),
            event=event,
            data=data,
        )

        for hook in hooks:
            try:
                result = await hook.handler(context)

                if result and result.get("blocked"):
                    return HookResult(
                        blocked=True,
                        reason=result["reason"],
                        blockedBy=hook.pluginName,
                    )

                if result and result.get("modified"):
                    context.data = deep_merge(context.data, result["modified"])

            except Exception as e:
                log.error(f"Hook {hook.pluginName}:{event} failed: {e}")
                # Hook failures are non-fatal; continue to next hook

        return HookResult(blocked=False, data=context.data)
```

## 7. Acceptance Criteria

- [ ] All 7 hook events fire at the correct lifecycle points
- [ ] Hooks execute serially in priority order
- [ ] A blocking hook (`blocked: true`) stops the chain and prevents the action
- [ ] Pre-hook modifications are visible to subsequent hooks and the final action
- [ ] Post-hook modifications are applied to the tool result
- [ ] Hook failures (exceptions) are caught and logged without crashing the session
- [ ] Plugins can register hooks via the PluginAPI
- [ ] `tool.execute.before` can block tool execution and return an error to the model
- [ ] `prompt.submit` can rewrite the user message before it reaches the LLM

## 8. Source Files

| File | Responsibility |
|------|------|
| `packages/plugin/src/index.ts` | Plugin API definition, hook registration interface |
| `src/plugin/index.ts` | Hook engine implementation, serial execution |
| `src/session/prompt.ts` | Fires prompt.submit, turn.stop hooks |
| `src/tool/governance.ts` | Fires tool.execute.before/after, tool.permission.check |

## 9. Product Manager Summary

> Hooks are the key to transforming a closed product into a governable platform — enabling security policies, user preferences, and plugin behaviors to intervene at runtime.
