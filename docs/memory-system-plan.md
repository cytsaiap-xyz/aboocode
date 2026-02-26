# Native Memory System for Aboocode

## Context

The user has `opencode-code-buddy` — a memory plugin that gives AI coding sessions persistent memory across restarts. Its core value:

1. **Cross-session memory** — Remember decisions, patterns, bugfixes, lessons learned. Next session, the AI already knows your project.
2. **Auto-observer** — Automatically records what you did (tasks, decisions, errors) without manual commands.
3. **Knowledge graph** — Track entities (components, technologies) and their relationships.
4. **Error learning** — Record mistakes so the AI doesn't repeat them.
5. **Context survival** — Inject memories into compaction so knowledge isn't lost when context overflows.

The old plugin was constrained by opencode's hook API — it had to use JSON files for storage, raw `fetch()` for LLM calls, observation buffers with debounced flushes, etc.

**Now, inside aboocode's core, we have direct access to:**
- SQLite database (drizzle-orm) — proper persistent storage
- Session messages — can read full conversation history from DB
- Bus events — subscribe to `session.idle`, `session.status`, `message.updated`
- `Instance.state()` — proper lifecycle management
- System prompt assembly — inject memory directly into `system[]` array
- Compaction hook point — inject into compaction context
- LLM via AI SDK — use the same provider infrastructure
- `Tool.define()` — register tools as built-in alongside Read/Edit/Bash

---

## Architecture Overview

```
src/memory/
  index.ts          — Memory namespace, init(), public API
  memory.sql.ts     — SQLite table definitions (memory, entity, relation)
  types.ts          — Type definitions
  extract.ts        — Auto-extract memories from completed sessions via LLM
  search.ts         — Memory search (text similarity + keyword matching)
  context.ts        — Build memory context for system prompt & compaction

src/tool/
  memory.ts         — Memory tools (search, add, delete, stats, entities)
```

---

## Step 1: Database tables

**New file:** `packages/aboocode/src/memory/memory.sql.ts`

Three tables using drizzle-orm, following the same pattern as `session.sql.ts`:

```sql
-- Memories: decisions, patterns, lessons, bugfixes, notes
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  session_id    TEXT,                    -- source session (nullable for manual adds)
  type          TEXT NOT NULL,           -- decision | pattern | bugfix | lesson | feature | note
  category      TEXT NOT NULL,           -- solution | knowledge
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]', -- JSON array
  time_created  INTEGER NOT NULL,
  time_updated  INTEGER NOT NULL
);
CREATE INDEX memory_project_idx ON memory (project_id);

-- Knowledge graph entities
CREATE TABLE entity (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,           -- component | file | technology | pattern | decision
  observations  TEXT NOT NULL DEFAULT '[]', -- JSON array
  tags          TEXT NOT NULL DEFAULT '[]',
  time_created  INTEGER NOT NULL,
  time_updated  INTEGER NOT NULL
);
CREATE INDEX entity_project_idx ON entity (project_id);

-- Entity relationships
CREATE TABLE relation (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  from_entity   TEXT NOT NULL,
  to_entity     TEXT NOT NULL,
  type          TEXT NOT NULL,           -- depends_on | implements | related_to | uses
  description   TEXT,
  time_created  INTEGER NOT NULL,
  time_updated  INTEGER NOT NULL
);
CREATE INDEX relation_project_idx ON relation (project_id);
```

**New migration:** `packages/aboocode/migration/<timestamp>_add_memory_tables/migration.sql`

**Register in schema:** Add exports to `packages/aboocode/src/storage/schema.ts`

---

## Step 2: Memory module core

**New file:** `packages/aboocode/src/memory/index.ts`

```typescript
export namespace Memory {
  // State: initialized per-project via Instance.state()
  // Subscribes to Bus events for auto-extraction

  export function init(): void
    // Subscribe to SessionStatus.Event.Status (type=idle) → trigger extraction
    // Subscribe to Session.Event.Deleted → cleanup

  export async function add(input: { title, content, type, tags?, sessionID? }): MemoryEntry
  export async function search(query: string, opts?: { limit?, type? }): MemoryEntry[]
  export async function recent(limit?: number): MemoryEntry[]
  export async function remove(id: string): void
  export async function stats(): Stats

  // Entity/relation CRUD
  export async function addEntity(input): Entity
  export async function searchEntities(query: string): Entity[]
  export async function addRelation(input): Relation

  // Context building
  export async function buildContext(opts?: { limit? }): string[]
    // Returns array of strings to inject into system prompt
}
```

All DB operations use `Database.use()` with drizzle queries — same pattern as Session/Message modules.

---

## Step 3: Auto-extraction from sessions

**New file:** `packages/aboocode/src/memory/extract.ts`

When a session goes idle (bus event `session.status` with `type: "idle"`):

1. Read the session's messages from DB via `Session.messages({ sessionID, limit: 50 })`
2. Filter to messages since the last extraction for this session
3. Check if there were meaningful changes (edits, bash commands — not just reads)
4. Build a summary of what happened from the message text + tool parts
5. Use LLM to extract structured memories:
   - What decisions were made?
   - What bugs were fixed?
   - What patterns were established?
   - What lessons were learned?
6. Deduplicate against existing memories (Jaccard similarity from code-buddy's `helpers.ts`)
7. Store new/merged memories in the `memory` table

**LLM call approach:** Use `SessionPrompt.prompt()` with a hidden `memory-extractor` agent (similar to how `compaction` and `title` agents work) to make a single LLM call. This reuses aboocode's existing provider infrastructure — no raw `fetch()` needed.

**Dedup:** Port the Jaccard similarity function from code-buddy's `helpers.ts` into `search.ts`. For sync paths, use Jaccard only. For async paths, optionally use LLM semantic comparison.

---

## Step 4: Memory context injection

**New file:** `packages/aboocode/src/memory/context.ts`

Two injection points:

### 4a. System prompt injection
**File to modify:** `packages/aboocode/src/session/prompt.ts`

In the main loop where the system prompt is assembled (~line 659):
```typescript
const system = [
  ...(await SystemPrompt.environment(model)),
  ...(await InstructionPrompt.system()),
  ...(await Memory.buildContext({ limit: 5 })),  // NEW
]
```

`Memory.buildContext()` queries the most relevant memories for the current project and returns formatted strings like:
```
## Project Memory
- [decision] Chose JWT for auth — stored in middleware/auth.ts
- [pattern] All API routes follow REST conventions with /api/v1 prefix
- [bugfix] Fixed race condition in WebSocket reconnect — added mutex lock
```

### 4b. Compaction context injection
**File to modify:** `packages/aboocode/src/session/compaction.ts`

After the `Plugin.trigger("experimental.session.compacting", ...)` call (~line 145), add:
```typescript
const memoryContext = await Memory.buildContext({ limit: 10 })
compacting.context.push(...memoryContext)
```

This ensures memories survive compaction — they're included in the summarization prompt.

---

## Step 5: Memory tools

**New file:** `packages/aboocode/src/tool/memory.ts`

8 tools using `Tool.define()`:

| Tool | Description |
|------|-------------|
| `memory_search` | Search memories by query, type, or tags |
| `memory_add` | Manually add a memory (title, content, type, tags) |
| `memory_recent` | List N most recent memories |
| `memory_delete` | Delete a memory by ID (with confirmation) |
| `memory_stats` | Show memory/entity/relation counts by type |
| `memory_entity_add` | Create a knowledge graph entity |
| `memory_entity_search` | Search entities |
| `memory_relation_add` | Create a relationship between entities |

**Register in tool registry:**
**File to modify:** `packages/aboocode/src/tool/registry.ts`

Import and add all memory tools to the `all()` return array.

---

## Step 6: Memory extractor agent

**File to modify:** `packages/aboocode/src/agent/agent.ts`

Add a hidden built-in agent (like `compaction` and `title`):

```typescript
{
  name: "memory-extractor",
  mode: "subagent",
  hidden: true,
  native: true,
  temperature: 0.3,
  permission: { "*": "deny" },
  prompt: "Extract structured memories from the session conversation..."
}
```

This agent has no tool access — it just reads conversation context and outputs structured JSON with extracted memories.

---

## Step 7: Config integration

**File to modify:** `packages/aboocode/src/config/config.ts`

Add to the `Config.Info` Zod schema:

```typescript
memory: z.object({
  enabled: z.boolean().optional().describe("Enable memory system (default: true)"),
  autoExtract: z.boolean().optional().describe("Auto-extract memories on session idle (default: true)"),
  maxMemories: z.number().optional().describe("Max memories per project (default: 500)"),
  contextLimit: z.number().optional().describe("Max memories injected into system prompt (default: 5)"),
}).optional()
```

---

## Step 8: Initialize on startup

**File to modify:** `packages/aboocode/src/cli/cmd/tui/worker.ts`

Add `Memory.init()` in the initialization sequence to subscribe to bus events.

Also check `packages/aboocode/src/server/server.ts` — if the server has an init sequence, add there too (for headless/web mode).

---

## Files Summary

**New files:**

| File | Purpose |
|------|---------|
| `src/memory/index.ts` | Memory namespace, init, public API |
| `src/memory/memory.sql.ts` | SQLite table definitions |
| `src/memory/types.ts` | Type definitions |
| `src/memory/extract.ts` | Auto-extract memories from sessions via LLM |
| `src/memory/search.ts` | Search (text similarity, dedup via Jaccard) |
| `src/memory/context.ts` | Build context strings for prompt/compaction |
| `src/tool/memory.ts` | 8 memory tools |
| `migration/<ts>_add_memory/migration.sql` | DB migration |

**Modified files:**

| File | Change |
|------|--------|
| `src/storage/schema.ts` | Export memory tables |
| `src/tool/registry.ts` | Add memory tools to `all()` |
| `src/session/prompt.ts` | Inject memory context into system prompt |
| `src/session/compaction.ts` | Inject memory context into compaction |
| `src/agent/agent.ts` | Add hidden `memory-extractor` agent |
| `src/config/config.ts` | Add `memory` config section |
| `src/cli/cmd/tui/worker.ts` | Call `Memory.init()` on startup |

---

## What's different from code-buddy

| Aspect | Code-buddy (plugin) | Aboocode (native) |
|--------|---------------------|-------------------|
| Storage | JSON files | SQLite (same DB as sessions) |
| Tool observation | Hook-based buffer + flush | Direct Bus event subscription |
| Memory extraction | Heuristic text analysis | LLM-powered extraction from full session |
| LLM calls | Raw fetch() to OpenAI API | Reuse aboocode's AI SDK providers |
| State | Custom PluginState class | Instance.state() pattern |
| Config | Separate config.json | Integrated in aboocode.json |
| Tools | 21 tools via plugin hook | 8 focused tools via Tool.define() |
| System prompt | Only via compaction hook | Direct injection into system prompt array |
| Dedup | Jaccard + LLM semantic | Jaccard (ported) + LLM via extractor agent |

---

## Verification

1. **Build:** `cd packages/aboocode && bun run build`
2. **DB migration:** Start aboocode → verify `memory`, `entity`, `relation` tables created
3. **Manual memory:** Use `memory_add` tool → verify row appears in DB
4. **Search:** Use `memory_search` → verify results returned
5. **Auto-extraction:** Have a coding session, let it go idle → verify memories auto-extracted
6. **System prompt:** Start new session → verify memories appear in system prompt context
7. **Compaction:** Trigger compaction → verify memories injected into summary
8. **Persistence:** Restart aboocode → verify memories persist and inject on new session
9. **Config:** Set `memory.enabled: false` in `aboocode.json` → verify no injection/extraction
