# Aboocode Architecture & Workflow

> Version 0.8.5 | Last updated: 2026-04-08

Aboocode is an AI coding agent built for the terminal. It is a TypeScript/Bun application that orchestrates LLM interactions with a rich tool system, persistent sessions, multi-agent coordination, and workspace isolation. This document describes the internal architecture, data flows, and key subsystems.

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Entry Points](#entry-points)
3. [Session & Query Loop](#session--query-loop)
4. [Provider System](#provider-system)
5. [Agent System](#agent-system)
6. [Tool System](#tool-system)
7. [Permission System](#permission-system)
8. [Context Management & Compaction](#context-management--compaction)
9. [Memory System](#memory-system)
10. [Plugin & Hook System](#plugin--hook-system)
11. [Workspace Isolation](#workspace-isolation)
12. [Background Tasks](#background-tasks)
13. [MCP Integration](#mcp-integration)
14. [Server & API](#server--api)
15. [Storage & Database](#storage--database)
16. [Event Bus](#event-bus)
17. [Configuration](#configuration)
18. [Data Flow Diagrams](#data-flow-diagrams)
19. [Package Structure](#package-structure)

---

## High-Level Overview

```
                          +------------------+
                          |   User (CLI/TUI) |
                          +--------+---------+
                                   |
                    +--------------v--------------+
                    |        Entry Points          |
                    |  CLI (yargs)  |  TUI (Solid) |
                    +--------------+--------------+
                                   |
                    +--------------v--------------+
                    |       Session Layer          |
                    |  prompt.ts -> processor.ts   |
                    |  transitions | compaction    |
                    |  token-budget | background   |
                    +--------------+--------------+
                           |              |
              +------------v--+    +------v---------+
              | Provider Layer |    |   Tool Layer   |
              | transform.ts   |    | registry.ts    |
              | llm.ts         |    | governance.ts  |
              +-------+--------+    | bash/read/edit |
                      |             +-------+--------+
                      |                     |
              +-------v--------+    +-------v--------+
              |  LLM Providers |    | Permission     |
              | Anthropic,     |    | next.ts        |
              | OpenAI, Google |    | allow/deny/ask |
              +----------------+    +----------------+
                                           |
                    +--------------+-------v--------+
                    |          Data Layer            |
                    |  SQLite (drizzle) | Bus/Events |
                    |  Session | Message | Part      |
                    +------------------------------- +
```

---

## Entry Points

### CLI (`src/index.ts`)

The primary entry point. Uses **yargs** to parse commands and route to handlers.

| Command | Handler | Description |
|---------|---------|-------------|
| `aboo` (default) | TUI | Opens the interactive terminal UI |
| `aboo run <prompt>` | RunCommand | Single-shot prompt execution |
| `aboo agent` | AgentCommand | Manage agents |
| `aboo auth` | AuthCommand | Provider authentication |
| `aboo mcp` | McpCommand | MCP server management |
| `aboo serve` | ServeCommand | Start the HTTP/WebSocket server |
| `aboo models` | ModelsCommand | List available models |
| `aboo pr` | PrCommand | PR workflow |
| `aboo session` | SessionCommand | Session management |
| `aboo upgrade` | UpgradeCommand | Self-update |
| `aboo export/import` | Export/ImportCommand | Session data portability |

**Startup sequence:**
1. Initialize logging (`Log.init`)
2. Set `AGENT=1`, `OPENCODE=1` environment variables
3. Run one-time SQLite migration if needed (progress bar on first run)
4. Parse and execute the matched command

### TUI Worker (`src/cli/cmd/tui/worker.ts`)

A separate Bun worker process that runs the backend for the TUI:

- Initializes the HTTP server (`Server.App()`)
- Starts an SSE event stream for real-time updates
- Exposes RPC methods: `fetch`, `server`, `checkUpgrade`, `reload`, `shutdown`
- Bootstraps project instances on demand via `Instance.provide()`

### TUI App (`src/cli/cmd/tui/app.tsx`)

A **Solid.js** terminal UI rendered with `@opentui/core`:

- Providers: Route, SDK, Sync, Dialog, Keybind, Theme
- Routes: Home (session list) and Session (chat view)
- Handles keyboard input, mouse, clipboard, and terminal resize

---

## Session & Query Loop

The core of Aboocode is the **session loop** — an iterative cycle of prompting the LLM, executing tools, and managing context.

### Files

| File | Role |
|------|------|
| `session/prompt.ts` | Main loop orchestration |
| `session/processor.ts` | LLM stream processing |
| `session/llm.ts` | Model streaming (Vercel AI SDK) |
| `session/transition.ts` | Typed loop transitions |
| `session/message-v2.ts` | Message and part types |
| `session/compaction.ts` | Context compression |
| `session/token-budget.ts` | Proactive/reactive budget checks |
| `session/background.ts` | Background task queue |
| `session/transcript.ts` | Pre-compaction transcript persistence |

### Loop Flow

```
SessionPrompt.prompt(input)
  |
  v
[Hook: prompt.submit] -- may cancel or modify input
  |
  v
createUserMessage() -- parse text, files, agent refs, subtasks
  |
  v
loop():
  |
  +---> [Micro-compact old tool results]
  |
  +---> [Check context overflow -> reactive compaction]
  |
  +---> [Drain completed background tasks -> inject notifications]
  |
  +---> [Resolve agent, isolation context, tools]
  |
  +---> [Proactive token budget check -> compact if >80%]
  |
  +---> [Build system prompt: stable prefix + dynamic suffix + memory + identity]
  |
  +---> SessionProcessor.process(streamInput)
  |       |
  |       +---> LLM.stream() via Vercel AI SDK
  |       |
  |       +---> Stream events: text-delta, tool-call, reasoning, finish
  |       |
  |       +---> Execute tool calls -> update parts -> return Transition
  |       |
  |       +---> Failure classification -> recovery strategy
  |
  +---> Handle Transition.Result:
          |
          +-- Terminal("completed") --> quality gate + stop hook --> break
          +-- Terminal("model_error") --> log error --> break
          +-- Terminal("permission_blocked") --> break
          +-- Continue("tool_use") --> next iteration
          +-- Continue("reactive_compact") --> compress context --> continue
          +-- Continue("max_output_tokens_recovery") --> inject "continue" --> retry (max 3x)
          +-- Continue("stop_hook_blocking") --> inject feedback --> continue
```

### Typed Transitions

Every loop exit and continuation has a typed reason (not ad-hoc strings):

**Terminal reasons** (loop exits):
`completed`, `max_turns`, `aborted_streaming`, `aborted_tools`, `prompt_too_long`, `stop_hook_prevented`, `hook_cancelled`, `model_error`, `permission_blocked`, `structured_output`

**Continue reasons** (loop iterates):
`tool_use`, `reactive_compact`, `proactive_compact`, `max_output_tokens_recovery`, `stop_hook_blocking`, `background_task_drain`, `compaction_task`, `subtask`, `overflow_compact`

### Message Format (V2)

Messages contain typed **parts**:

| Part Type | Description |
|-----------|-------------|
| `TextPart` | User or assistant text |
| `ReasoningPart` | Extended thinking output |
| `ToolPart` | Tool call + result with status lifecycle |
| `FilePart` | File/directory references with MIME |
| `AgentPart` | Agent delegation reference |
| `SubtaskPart` | Background subtask delegation |
| `SnapshotPart` | VCS snapshot |
| `CompactionPart` | Compaction marker |

Tool parts track a status lifecycle: `pending` -> `executing` -> `completed` | `denied` | `failed`

---

## Provider System

### Files

| File | Role |
|------|------|
| `provider/provider.ts` | Model loading, resolution, auth |
| `provider/transform.ts` | Provider-specific message normalization |
| `provider/models.ts` | Model schema definitions |
| `provider/models-snapshot.ts` | Bundled model database |

### Supported Providers

Anthropic, OpenAI, Azure OpenAI, Google (Gemini), Google Vertex, Mistral, Groq, AWS Bedrock, Cohere, xAI, Perplexity, OpenRouter, GitLab, and any OpenAI-compatible endpoint.

### Model Resolution

```
Config providers (user-defined)
  +
Bundled model snapshot (models-snapshot.ts)
  +
Environment variables (API keys)
  |
  v
Provider.getModel(providerID, modelID)
  |
  v
Fuzzy match if exact not found (fuzzysort)
  |
  v
Provider.Model { id, providerID, limit, cost, capabilities, options }
```

### Provider Transform

Each provider has quirks. `transform.ts` normalizes:

- **Anthropic**: Cache control annotations, beta headers, empty content filtering
- **Mistral**: 9-char alphanumeric tool IDs, message sequence enforcement
- **OpenAI**: Tool call ID sanitization
- **Google**: Modality mapping for multimodal input

The system prompt is split into **stable prefix** (cacheable) and **dynamic suffix** (per-session) to optimize prompt caching on providers that support it.

---

## Agent System

### File: `agent/agent.ts`

Agents define personas with different capabilities, permissions, and isolation modes.

### Built-in Agents

| Agent | Mode | Isolation | Purpose |
|-------|------|-----------|---------|
| `build` | primary | shared | Main coding agent — reads, writes, executes |
| `plan` | primary | read_only | Planning mode — reads only, no edits |
| `explore` | subagent | read_only | Codebase exploration |
| `verification` | subagent | read_only | Independent work verification (PASS/FAIL/PARTIAL) |
| `general` | subagent | shared | General-purpose subagent for multi-step tasks |
| `orchestrator` | primary | shared | Multi-turn coordinator for proactive responses |
| `compaction` | internal | shared | Context summarization |
| `summary` | internal | shared | Session title generation |
| `observer` | internal | shared | Background session monitoring |

### Agent Configuration

```typescript
interface AgentInfo {
  name: string
  description: string
  mode: "subagent" | "primary" | "all"
  permission: PermissionNext.Ruleset   // fine-grained tool access
  isolation?: "shared" | "read_only" | "temp" | "worktree"
  model?: { providerID, modelID }      // optional model override
  steps?: number                       // max turns before stopping
  temperature?: number
  topP?: number
  prompt?: string                      // custom system prompt
  allowedTools?: string[]              // whitelist
  disallowedTools?: string[]           // blacklist
  backgroundCapable?: boolean
}
```

Users can define custom agents in `aboocode.json`:

```json
{
  "agent": {
    "reviewer": {
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514",
      "isolation": "read_only",
      "prompt": "You are a code reviewer..."
    }
  }
}
```

---

## Tool System

### Files

| File | Role |
|------|------|
| `tool/tool.ts` | Base types: `Tool.Info`, `Tool.Context`, `Tool.define()` |
| `tool/registry.ts` | Tool registration and initialization |
| `tool/governance.ts` | 8-step governance pipeline with telemetry |
| `tool/toolsearch.ts` | Deferred tool loading (ToolSearch) |
| `tool/verify.ts` | Verification agent trigger |

### Built-in Tools

| Category | Tools |
|----------|-------|
| **File I/O** | `read`, `write`, `edit`, `glob`, `grep`, `ls`, `apply_patch` |
| **Execution** | `bash`, `batch` |
| **Search** | `codesearch`, `websearch`, `webfetch` |
| **Coordination** | `task`, `question`, `skill`, `plan` |
| **Development** | `lsp`, `verify`, `toolsearch` |
| **Team** | `plan_team`, `add_agent`, `delegate_task`, `delegate_tasks`, `list_team`, `finalize_team`, `disband_team`, `discuss` |

### Tool Lifecycle

```
1. Tool.define(id, { parameters, execute })
   |
2. ToolRegistry.tools(model, agent)  -- filter by model/agent capabilities
   |
3. Tool.init(initCtx)               -- async initialization
   |
4. Zod schema validation            -- parse args
   |
5. execute(args, ctx)               -- run with session context
   |
6. Truncate.output()                -- trim large output
   |
7. Return { title, metadata, output }
```

### Tool Context

Every tool receives:

```typescript
interface Tool.Context {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  callID?: string
  messages: MessageV2.WithParts[]
  metadata(input): void       // update tool metadata
  ask(input): Promise<void>   // request permission
}
```

### Governance Pipeline (Phase 9)

An 8-step auditable execution chain wraps every tool call:

1. **Find tool** by name
2. **Validate input** via Zod schema
3. **Run custom validators** (beyond schema — e.g., path sanitization)
4. **Fire pre-hooks** (`tool.execute.before`)
5. **Resolve permission** (allow/ask/deny)
6. **Execute tool**
7. **Record telemetry** (tool, duration, status, args — in-memory buffer, flushes at 50)
8. **Fire post-hooks** (`tool.execute.after`)

### Deferred Tool Loading (Phase 7)

When total tool count exceeds 15, MCP and custom tools are deferred. Only their names appear in the system prompt. The model uses `ToolSearch` to fetch full schemas on demand:

```
Model sees: "Available deferred tools: mcp_github_create_pr, mcp_slack_send, ..."
  |
  v
Model calls: ToolSearch({ query: "select:mcp_github_create_pr" })
  |
  v
Full schema returned, tool activated for the session
```

---

## Permission System

### File: `permission/next.ts`

Fine-grained access control for every tool operation.

### Rule Model

```typescript
interface Rule {
  permission: string    // tool name or pattern
  pattern: string       // file path, command, or "*"
  action: "allow" | "deny" | "ask"
}
```

### Resolution Flow

```
Tool requests permission
  |
  v
Match against ruleset (explicit rules first, then defaults)
  |
  +-- "allow" --> proceed
  +-- "deny"  --> block, return error to model
  +-- "ask"   --> prompt user for approval
        |
        +-- User approves "once"   --> proceed this time
        +-- User approves "always" --> save to DB, proceed
        +-- User rejects           --> block
```

### Doom Loop Detection

If the model makes 3 identical tool calls in a row (same tool + same args), a `doom_loop` permission check fires, asking the user whether to continue.

### Rule Precedence

```
Agent-specific rules (highest)
  |
User config rules
  |
Default rules (lowest)
```

---

## Context Management & Compaction

### Three-Layer Compression

Aboocode uses a three-layer approach to manage context window usage:

#### Layer 1: Micro-Compaction (Phase 0)

Before every LLM call, old tool results are silently cleared:

- Walks backward through messages
- After the 5 most recent tool results, marks older ones as `compacted`
- `MessageV2.toModelMessages()` replaces compacted content with `"[Old tool result content cleared]"`
- Extends usable context by 2-3x before full compaction fires
- Only affects safe tools: bash, read, grep, glob, edit, write, webfetch, websearch, codesearch, apply_patch, lsp

#### Layer 2: Proactive Compaction

At 80% of input token limit:

- Estimates current token usage via `TokenBudget.estimate()`
- If `shouldCompact()` returns true, creates a compaction task
- A dedicated compaction agent summarizes the conversation using a structured template (Goal, Instructions, Discoveries, Accomplished, Relevant files)

#### Layer 3: Reactive Compaction

At 95% of input token limit (or on actual context overflow error):

- Emergency compaction triggered
- Same process as proactive but at a higher urgency threshold
- Bounded: max 2 reactive compact retries before `prompt_too_long` terminal

### Transcript Persistence (Phase 2)

Before any compaction summarization, the full conversation is saved to disk:

```
~/.local/share/aboocode/transcripts/{sessionID}/{timestamp}.jsonl
```

Each line is a JSON object with `{ info, parts }`. Nothing is ever permanently lost.

### Identity Re-injection (Phase 3)

After compaction, the model loses awareness of its role. The system injects:

```xml
<identity>
You are the "build" agent — Primary coding agent, working in /path/to/project.
Context was compressed. The summary above contains your previous work.
Continue with the task described in the summary.
</identity>
```

This is cleared after the next successful LLM response.

### Token Budget

```typescript
interface TokenBudget.State {
  maxInputTokens: number      // model.limit.input or (context - maxOutput)
  maxOutputTokens: number     // model.limit.output or 32K default
  currentEstimate: number     // estimated from model messages
  compactThreshold: number    // maxInput * 0.8
  reactiveThreshold: number   // maxInput * 0.95
}
```

Guard: if `maxInputTokens <= 0` (unconfigured model), compaction is disabled to prevent infinite loops.

---

## Memory System

### Files

| File | Role |
|------|------|
| `memory/index.ts` | Core namespace: init, buildContext, append |
| `memory/context.ts` | Builds context strings for system prompt injection |
| `memory/extract.ts` | LLM-based memory extraction from sessions |
| `memory/markdown-store.ts` | Markdown file persistence |
| `memory/observer.ts` | Background session monitoring for auto-extraction |

### Memory Types

| Type | Description |
|------|-------------|
| `user_preference` | User's coding style, tool preferences |
| `user_role` | Role, expertise level, responsibilities |
| `feedback` | Corrections and confirmed approaches |
| `project_goal` | Current project objectives |
| `project_decision` | Architectural decisions and rationale |
| `external_reference` | Links to external resources |
| `workflow` | Recurring workflows and processes |
| `lesson_learned` | Insights from past incidents |

### Storage Format

Individual memory files with YAML frontmatter:

```markdown
---
name: User Role
description: Senior backend engineer focused on Go services
type: user_role
---
User is a senior backend engineer with 10 years of Go experience.
Prefers terse explanations with code examples over lengthy prose.
```

Index file `MEMORY.md` (max 200 lines) contains pointers:

```markdown
- [User Role](user_role.md) — Senior backend engineer, Go expert
- [Testing Feedback](feedback_testing.md) — Always use real DB, never mocks
```

### Auto-Extraction

When a session goes idle, the observer triggers extraction:
1. Builds conversation transcript
2. Runs extraction LLM to identify durable facts
3. Validates against `DURABLE_MEMORY_TYPES` allowlist
4. Rejects transient content (file structures, architecture dumps, session recaps)
5. Persists to memory directory

### Prompt Injection

`Memory.buildContext()` reads `MEMORY.md` (first 200 lines) and injects it into the system prompt's dynamic suffix section.

---

## Plugin & Hook System

### Files

| File | Role |
|------|------|
| `packages/plugin/src/index.ts` | Hook interface definitions |
| `src/plugin/index.ts` | Plugin loading and hook execution |

### Hook Lifecycle

| Hook | When | Can Do |
|------|------|--------|
| `prompt.submit` | Before user message processed | Modify text, cancel |
| `session.start` | Session loop begins | Setup, logging |
| `session.stop` | Before session ends | Block stop, inject feedback |
| `tool.execute.before` | Before tool runs | Modify args |
| `tool.execute.after` | After tool completes | Modify result |
| `tool.definition` | Tool sent to LLM | Modify description/params |
| `experimental.session.compacting` | Before compaction | Inject context, replace prompt |
| `experimental.chat.system.transform` | System prompt built | Modify system prompt |
| `chat.params` | LLM call params built | Modify temperature, etc |
| `chat.headers` | LLM request headers | Add custom headers |
| `permission.ask` | Permission UI shown | Custom permission handling |
| `shell.env` | Shell command runs | Modify environment |
| `auth` | Provider auth needed | Custom auth (OAuth, API key) |

### Plugin Loading

```
Config "plugin" list
  |
  +-- npm packages: auto-installed via bun
  +-- file:// URLs: loaded from local path
  +-- Built-in: CodexAuth, CopilotAuth, GitlabAuth
  |
  v
Plugin.init({ client, project, worktree, directory, serverUrl, $ })
  |
  v
Returns: { tool, hook } -- custom tools and hook implementations
```

---

## Workspace Isolation

### Files

| File | Role |
|------|------|
| `agent/isolation.ts` | Isolation modes, context creation, tool blocking |
| `agent/isolation-path.ts` | Session-to-path mapping |
| `worktree/index.ts` | Git worktree create/remove/reset |

### Isolation Modes

| Mode | CWD | Can Write | Use Case |
|------|-----|-----------|----------|
| `shared` | Project directory | Yes | Build agent, general tasks |
| `read_only` | Project directory | No | Explore, verify, plan agents |
| `temp` | Temp directory | Yes (temp only) | Verification scripts |
| `worktree` | Git worktree | Yes (worktree only) | Background tasks, experiments |

### Read-Only Enforcement

Two layers:
1. **Tool blocking** (`isToolBlocked`): Blocks `write`, `edit`, `apply_patch`, `multiedit`, `bash`, `notebook_edit`
2. **Shell filtering** (`shellAllowed`): Defense-in-depth regex blocks destructive commands (rm, mv, git push, etc.)

### Worktree Lifecycle

```
TaskTool({ isolation: "worktree" })
  |
  v
Worktree.create({ name, branch })
  |
  v
Symlink node_modules from parent (avoid disk bloat)
  |
  v
Agent executes in worktree directory
  |
  v
On completion: check uncommitted changes
  |
  +-- Changes exist: keep worktree, warn user
  +-- No changes: Worktree.remove()
```

---

## Background Tasks

### File: `session/background.ts`

Agents can spawn tasks that run without blocking the main loop.

### Flow

```
TaskTool({ run_in_background: true, prompt: "..." })
  |
  v
BackgroundTasks.register(parentSessionID, taskID, description, agent, promise)
  |
  v
Main loop continues immediately
  |
  v
[Before each LLM call in main loop]
BackgroundTasks.drain(parentSessionID)
  |
  v
Completed tasks -> inject as synthetic user messages:
  <task-notification>
  <task-id>abc123</task-id>
  Background task "Run tests" (@verification) completed.
  Output file: .aboocode/tasks/{sessionID}/{taskID}.md
  <result>...</result>
  </task-notification>
```

---

## MCP Integration

### File: `src/mcp/index.ts`

Aboocode supports **Model Context Protocol** servers for extended capabilities.

### Transport Types

| Transport | Description |
|-----------|-------------|
| `stdio` | Spawn MCP server as child process |
| `sse` | Connect via Server-Sent Events |
| `streamable-http` | Connect via HTTP streaming |

### MCP Tool Flow

```
Config defines MCP servers
  |
  v
MCP client connects (stdio/sse/http)
  |
  v
Server reports available tools
  |
  v
convertMcpTool() -> AI SDK tool format
  |
  v
Tools added to session (eager or deferred via ToolSearch)
  |
  v
On tool call: route to MCP server, return result
```

### OAuth Support

MCP servers that require auth use `McpOAuthProvider` for the OAuth flow, with browser-based login and callback handling.

---

## Server & API

### File: `src/server/server.ts`

A **Hono.js** HTTP server with WebSocket support.

### Route Groups

| Route Group | Purpose |
|-------------|---------|
| `/session` | Session CRUD, prompt execution |
| `/project` | Project info, VCS status |
| `/provider` | Model listing, provider status |
| `/config` | Configuration read/write |
| `/mcp` | MCP server management |
| `/file` | File read/write |
| `/permission` | Permission requests/replies |
| `/question` | Interactive question handling |
| `/pty` | Pseudo-terminal (for bash tool) |
| `/tui` | TUI-specific endpoints |
| `/global` | Cross-project operations |

### Event Streaming

The server provides SSE endpoints for real-time event broadcasting. The TUI worker subscribes to these and forwards events via RPC to the UI.

### Authentication

Optional Basic Auth via `ABOOCODE_SERVER_PASSWORD` and `ABOOCODE_SERVER_USERNAME` flags.

---

## Storage & Database

### File: `src/storage/db.ts`

**SQLite** database via **Drizzle ORM** with `bun:sqlite`.

### Location

```
~/.local/share/aboocode/aboocode.db
```

### Pragmas

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
```

### Schema

| Table | Description |
|-------|-------------|
| `ProjectTable` | Project metadata (directory, VCS info) |
| `SessionTable` | Session info (title, parent, timestamps) |
| `MessageTable` | Messages (role, agent, tokens, cost) |
| `PartTable` | Message parts (text, tool, file, etc.) |
| `PermissionTable` | Saved permission approvals |

### Migration System

Migrations are bundled at build time from `migration/` directory. Each migration has a timestamp-based name and a `migration.sql` file. Applied automatically on database initialization.

---

## Event Bus

### Files

| File | Role |
|------|------|
| `bus/index.ts` | Per-instance pub/sub |
| `bus/bus-event.ts` | Zod-typed event definitions |
| `bus/global.ts` | Cross-instance event broadcast |

### Pattern

```typescript
// Define event
const MyEvent = BusEvent.define("my.event", z.object({ id: z.string() }))

// Publish
Bus.publish(MyEvent, { id: "123" })

// Subscribe
Bus.subscribe(MyEvent, (payload) => { /* handle */ })
```

### Key Events

| Event | Published When |
|-------|---------------|
| `session.compacted` | Context compression completed |
| `session.status` | Session state changed (idle/busy) |
| `permission.asked` | Permission approval needed |
| `permission.replied` | User responded to permission |
| `worktree.ready` | Worktree created successfully |
| `worktree.failed` | Worktree creation failed |
| `mcp.tools_changed` | MCP server tools updated |

---

## Configuration

### File: `src/config/config.ts`

### Loading Precedence (low to high)

```
1. Remote .well-known/aboocode   (org defaults)
2. Global ~/.config/aboocode/    (user defaults)
3. ABOOCODE_CONFIG env var       (custom path)
4. Project aboocode.json         (project-specific)
5. .aboocode/ directory          (project agents, commands, plugins)
6. ABOOCODE_CONFIG_CONTENT       (inline JSON override)
7. Managed config directory      (enterprise, highest priority)
```

### Config Schema

```jsonc
{
  // Provider configuration
  "provider": {
    "nvidia": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NVIDIA",
      "options": { "baseURL": "...", "apiKey": "..." },
      "models": {
        "deepseek-v3.2": {
          "name": "DS32",
          "limit": { "context": 131072, "output": 16384 }
        }
      }
    }
  },

  // Agent configuration
  "agent": {
    "build": {
      "model": "nvidia/deepseek-v3.2",
      "tools": { "write": true, "edit": true, "bash": true }
    }
  },

  // Permission defaults
  "permission": {
    "bash": "ask",
    "write": "allow",
    "external_directory": "ask"
  },

  // Memory settings
  "memory": {
    "enabled": true,
    "autoExtract": true
  },

  // Compaction settings
  "compaction": {
    "auto": true,
    "microCompact": true,
    "proactiveThreshold": 0.8,
    "reactiveThreshold": 0.95
  },

  // Plugin list
  "plugin": [
    "aboocode-plugin-my-tool",
    "file://./my-plugin.ts"
  ]
}
```

---

## Data Flow Diagrams

### Complete Request Lifecycle

```
User types message
  |
  v
[prompt.submit hook] -- validate/modify/cancel
  |
  v
Create user message (text + file parts)
  |
  v
=== LOOP START ===
  |
  +--1. Micro-compact old tool results (keep recent 5)
  |
  +--2. Check context overflow -> emergency compaction
  |
  +--3. Drain background task completions -> inject notifications
  |
  +--4. Resolve agent + isolation context
  |
  +--5. Build tool set (filter by agent permissions + model capabilities)
  |
  +--6. Estimate token budget -> proactive compaction if >80%
  |
  +--7. Build system prompt:
  |     [Stable prefix: model instructions, rules]
  |     [Dynamic suffix: env info, date, instructions]
  |     [Memory context: MEMORY.md content]
  |     [Identity: post-compaction agent context]
  |
  +--8. Stream LLM response:
  |     |
  |     +-- Text delta -> update assistant message
  |     +-- Reasoning delta -> update reasoning part
  |     +-- Tool call -> validate + permission + execute
  |     |     |
  |     |     +-- [Governance pipeline: validate -> pre-hook -> execute -> telemetry -> post-hook]
  |     |     +-- Result stored as tool part
  |     |
  |     +-- Finish -> check finish reason
  |
  +--9. Evaluate transition:
  |     +-- Terminal -> quality gate -> stop hook -> break
  |     +-- Continue(tool_use) -> next iteration
  |     +-- Continue(reactive_compact) -> compress -> continue
  |     +-- Continue(max_output_recovery) -> inject "continue" -> retry
  |
=== LOOP END ===
  |
  v
[session.end hook] with terminal reason
  |
  v
Return final assistant message to caller
```

### Tool Execution Detail

```
Model emits tool_call(name, args)
  |
  v
Lookup tool in resolved set
  |
  v
Zod validation (schema parse)
  |
  +-- Invalid -> return validation error to model
  |
  v
Custom validators (governance step 3)
  |
  v
Pre-hooks (tool.execute.before)
  |
  v
Permission check (PermissionNext.evaluate)
  |
  +-- "deny" -> return denial to model
  +-- "ask"  -> prompt user -> once/always/reject
  |
  v
Execute tool with context
  |
  v
Record telemetry (tool, duration, status)
  |
  v
Post-hooks (tool.execute.after)
  |
  v
Truncate output if needed
  |
  v
Store result in ToolPart -> model sees it next iteration
```

---

## Package Structure

```
Aboocode/
  packages/
    aboocode/              # Core application
      src/
        agent/             # Agent definitions, isolation, paths
        bus/               # Event bus system
        cli/               # CLI commands and TUI
          cmd/
            tui/           # Terminal UI (Solid.js)
        config/            # Configuration loading
        flag/              # Feature flags
        hook/              # Quality gates
        id/                # ID generation (ULID-based)
        installation/      # Version, update detection
        lsp/               # Language Server Protocol integration
        mcp/               # Model Context Protocol client
        memory/            # Persistent memory system
        permission/        # Access control
        plugin/            # Plugin loading
        project/           # Project/instance management
        provider/          # LLM provider abstraction
          sdk/             # Custom provider SDKs (Copilot)
        server/            # HTTP/WebSocket server (Hono)
          routes/          # API route handlers
        session/           # Core session loop
          prompt/          # System prompt templates
        share/             # Session sharing
        shell/             # Shell execution
        snapshot/          # VCS snapshots
        storage/           # SQLite database
        tool/              # Tool implementations
        util/              # Utilities (token, filesystem, log)
        worktree/          # Git worktree management
      script/              # Build and publish scripts
      migration/           # SQLite migrations
      test/                # Test suite

    plugin/                # Plugin SDK (hook interface definitions)
    sdk/                   # Client SDK (JS + OpenAPI)
    script/                # Shared build utilities
    console/               # Web console
    desktop/               # Desktop app (Tauri)
    web/                   # Documentation website
    enterprise/            # Enterprise features
    containers/            # Docker images
    extensions/            # IDE extensions (Zed)
```

---

## Key Design Decisions

1. **Typed transitions over string returns**: Every loop exit/continuation has an explicit typed reason, enabling precise routing and auditing.

2. **Three-layer compaction**: Micro-compact extends context 2-3x, proactive compact prevents overflow, reactive compact is the safety net. Transcripts are saved before any compression.

3. **Permission as first-class**: Every tool operation goes through a rule-based permission system. No tool runs without explicit allowance.

4. **Isolation by role**: Agents that shouldn't write (explore, verify) are physically prevented via tool blocking, not just prompt instructions.

5. **Provider-agnostic**: The same session loop works across all providers. Provider-specific quirks are handled in the transform layer.

6. **Plugin extensibility**: Hooks at every lifecycle point (prompt submit, tool execute, compaction, system prompt) allow deep customization without forking.

7. **Memory persistence**: Durable facts survive across sessions. Transient state (file structures, architecture dumps) is rejected by the extraction validator.

8. **Background execution**: Long-running tasks don't block the main conversation. Results are injected as notifications when ready.
