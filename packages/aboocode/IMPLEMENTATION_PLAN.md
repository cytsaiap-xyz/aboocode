# Aboocode Implementation Plan

## Context

Build "Aboocode" - a terminal UI AI coding assistant based on cytsaiap-xyz/aboocode with three key enhancements: hot-reloadable agents/skills/tools, integrated multi-agent team orchestration (from opencode-agent-team), and parallel subagent execution. The approach is to fork opencode and modify it rather than build from scratch.

**User decisions:**
- Config directories: `.aboocode/` (clean break, no `.opencode/` compat)
- Orchestrator: additional agent alongside `build` (not replacing it)
- Default LLM: none — users must configure their provider on first run

---

## Phase 0: Fork Setup & Rebranding

### Step 0.1: Copy opencode into working directory
- Copy `opencode-reference/` contents into `/Users/steventsai/Documents/Aboocode/`
- Initialize git: `git init`

### Step 0.2: Rebrand package.json
- **`package.json`** (root): name → `aboocode`
- **`packages/aboocode/package.json`**: name → `aboocode`, bin key `opencode` → `aboo`

### Step 0.3: Config directory rename `.opencode/` → `.aboocode/`
- **`packages/aboocode/src/config/config.ts`**: replace all `.opencode` directory references with `.aboocode`
- **`packages/aboocode/src/config/markdown.ts`**: update any `.opencode` references
- **`packages/aboocode/src/skill/skill.ts`**: update scan paths
- **`packages/aboocode/src/tool/registry.ts`**: update tool scan paths
- Global grep for `".opencode"` and `'.opencode'` across `packages/aboocode/src/` and update

### Step 0.4: Remove default LLM provider
- **`packages/aboocode/src/plugin/index.ts`**: remove `opencode-anthropic-auth` from `BUILTIN` array
- **`packages/aboocode/src/config/config.ts`**: ensure no default provider/model is set
- Add first-run check: if no provider configured, prompt user to set one

### Step 0.5: Update user-facing strings
- Search for `"opencode"` / `"OpenCode"` in prompts, log messages, TUI text
- Replace with `"aboo"` / `"Aboocode"` where user-facing
- Update ASCII logo from "OPENCODE" to "ABOOCODE"

---

## Phase 1: Hot-Reload for Agents, Skills, Tools

### Step 1.1: Create HotReload module
**New file:** `packages/aboocode/src/hot-reload/index.ts`

```
- Define HotReload.Event.Reloaded bus event (type: tool|skill|agent, files: string[])
- init() subscribes to FileWatcher.Event.Updated
- Classify changes: isToolFile(), isSkillFile(), isAgentFile()
- 500ms debounce per file to handle rapid editor saves
- On debounce fire: call ToolRegistry.reload() / Skill.reload() / Agent.reload()
- Publish HotReload.Event.Reloaded for TUI notifications
```

### Step 1.2: Extend FileWatcher to watch config directories
**File:** `packages/aboocode/src/file/watcher.ts`

- After existing directory subscriptions, subscribe to each dir from `Config.directories()`
- Watch subdirs: `tool/`, `tools/`, `skill/`, `skills/`, `agent/`, `agents/`
- Watch external skill dirs: `.claude/skills/`, `.agents/skills/`
- Remove the `OPENCODE_EXPERIMENTAL_FILEWATCHER` gate for config directory watching (keep it for project directory watching)

### Step 1.3: Add reload() to ToolRegistry
**File:** `packages/aboocode/src/tool/registry.ts`

- Extract tool-loading logic from `Instance.state()` init into `async function loadCustomTools()`
- Add `export async function reload(changedFile?: string)` that re-runs `loadCustomTools()`
- Use Bun cache-busting: append `?t=${Date.now()}` to import URLs on reload
- Update cached state in-place (mutate `custom` array)

### Step 1.4: Add reload() to Skill
**File:** `packages/aboocode/src/skill/skill.ts`

- Extract skill-scanning logic from `Instance.state()` init into `async function loadAllSkills()`
- Add `export async function reload()` that re-runs `loadAllSkills()`
- Update cached state in-place

### Step 1.5: Add reload() to Agent
**File:** `packages/aboocode/src/agent/agent.ts`

- Extract agent-building logic from `Instance.state()` init into `async function loadAgents()`
- Add `export async function reload()` that re-runs `loadAgents()`
- Update cached state in-place

### Step 1.6: Wire HotReload into startup
**File:** `packages/aboocode/src/project/bootstrap.ts`

- Call `HotReload.init()` after `FileWatcher.init()`

### Step 1.7: TUI reload notification
- Subscribe to `HotReload.Event.Reloaded` in TUI layer
- Show brief status message: "Tools reloaded", "Skills reloaded", etc.

---

## Phase 2: Agent-Team Integration (Real Dynamic Agents via Hot-Reload)

**Key architectural difference from the original plugin:** The opencode-agent-team plugin used a "worker" agent workaround — a single generic subagent with its system prompt swapped at dispatch time — because opencode couldn't hot-reload agents. Aboocode has hot-reload (Phase 1), so we can do it properly: **`add_agent` writes a real agent `.md` file to `.aboocode/agents/`, hot-reload picks it up as a first-class agent, and `delegate_task` dispatches to the actual specialized agent.**

### Step 2.1: Create TeamManager (simplified)
**New file:** `packages/aboocode/src/team/manager.ts`

Inspired by `opencode_plugins/agent-team/src/team-manager.ts` but simplified:
- Use `Instance.state()` for team state
- Track: `taskSummary`, `pendingAgents[]` (staging), `activeAgentIds[]` (finalized)
- Methods: `startTeam()`, `addAgent()`, `finalizeTeam()`, `listTeam()`, `disbandTeam()`
- **No in-memory agent specs** — agents live as real files on disk

### Step 2.2: Create team tools (real agent lifecycle)
**New file:** `packages/aboocode/src/tool/team.ts`

7 tools using `Tool.define()`:

| Tool | Behavior |
|------|----------|
| `plan_team` | Initialize team planning state with task summary |
| `add_agent` | **Write `.aboocode/agents/<id>.md`** with YAML frontmatter (name, description, mode: subagent, permissions) + system prompt body. Hot-reload auto-detects the new file → agent becomes available in `Agent.list()` |
| `finalize_team` | Validate ≥2 agents exist, move from staging to active. Confirm all agent files were written and hot-reloaded successfully via `Agent.get(id)` |
| `delegate_task` | Look up the **real agent** via `Agent.get(agent_id)`, create child session via `Session.create({ parentID })`, execute via `SessionPrompt.prompt({ agent: agent_id })`. The agent's own system prompt (from the .md file) is used natively — no prompt injection needed |
| `delegate_tasks` | Same as delegate_task but dispatches multiple agents concurrently (Phase 3) |
| `list_team` | List active team agents and their status |
| `disband_team` | **Delete `.aboocode/agents/<id>.md`** files for all team agents. Hot-reload detects removal → agents disappear from `Agent.list()` |

**Agent .md file format** (written by `add_agent`):
```markdown
---
name: auth-model-dev
description: Creates User model and validation logic
mode: subagent
permission:
  read: allow
  write: allow
  edit: allow
  bash: allow
  glob: allow
  grep: allow
---
You are a specialized developer focused on data models and validation.

[orchestrator-provided system prompt here]

## Task Context
[skill context injected here if skills were specified]
```

### Step 2.3: Port KnowledgeBridge
**New file:** `packages/aboocode/src/team/knowledge-bridge.ts`

Port from `opencode_plugins/agent-team/src/knowledge-bridge.ts`:
- `loadKnowledgeContext()`, `buildOrchestratorKnowledgeSection()`, `buildWorkerRecordingInstructions()`
- Replace raw `readFile` with opencode's `Filesystem.readText()`
- Knowledge context gets appended to dynamically-created agent .md files when relevant

### Step 2.4: Ensure hot-reload handles agent creation/deletion rapidly
**File:** `packages/aboocode/src/hot-reload/index.ts`

For agent-team workflow, `add_agent` writes a file and immediately needs it available. Ensure:
- Agent file writes trigger **immediate** reload (bypass the 500ms debounce for `.aboocode/agents/` directory)
- Or: `add_agent` calls `Agent.reload()` directly after writing the file (synchronous path)
- `finalize_team` verifies all agents are loaded via `Agent.get(id)` before proceeding

### Step 2.5: Register team tools in registry
**File:** `packages/aboocode/src/tool/registry.ts`

Add all 7 team tools to the `all()` function's return array.

### Step 2.6: Add orchestrator as built-in agent
**File:** `packages/aboocode/src/agent/agent.ts`

**New file:** `packages/aboocode/src/agent/prompt/orchestrator.txt` — from `agent-team/agents/orchestrator.md` body

Only the orchestrator is built-in. No static "worker" agent — team members are created dynamically.

Agent definition:
- **orchestrator**: mode `"primary"`, all file/code tools denied, only team tools + question + skill allowed
- Permissions: `{ plan_team: allow, add_agent: allow, finalize_team: allow, delegate_task: allow, delegate_tasks: allow, list_team: allow, disband_team: allow, question: allow, skill: allow, "*": deny }`

### Step 2.7: Inject skill listing into orchestrator system prompt
**File:** `packages/aboocode/src/agent/agent.ts`

When building the orchestrator prompt:
- Call `Skill.all()` to get available skills
- Append skill names + descriptions so orchestrator can assign them to team agents
- When `add_agent` writes the .md file, inject matched skill content into the prompt body

### Step 2.8: Inject knowledge context
**File:** `packages/aboocode/src/agent/agent.ts`

When building the orchestrator prompt:
- Call `loadKnowledgeContext()` from knowledge-bridge
- Append `buildOrchestratorKnowledgeSection()` to system prompt

---

## Phase 3: Parallel Subagent Execution

### Step 3.1: Implement `delegate_tasks` tool
**File:** `packages/aboocode/src/tool/team.ts`

```
Parameters: delegations[] with { agent_id, task, depends_on?: string[] }

Execution:
1. Build dependency DAG from depends_on fields
2. Execute in waves: tasks with satisfied deps run concurrently via Promise.allSettled()
3. Each task: create child session → SessionPrompt.prompt() → collect result
4. Pass completed task results as context to dependent tasks
5. Aggregate all results into formatted output
6. Handle errors per-task (one failure doesn't stop others)
```

Max concurrent subtasks: 5 (configurable via `aboocode.jsonc` → `experimental.max_parallel_subtasks`)

### Step 3.2: Modify prompt loop for concurrent SubtaskParts
**File:** `packages/aboocode/src/session/prompt.ts`

Extract subtask execution logic into `async function executeSubtask()`.

Change the loop to process multiple pending subtasks concurrently:
```
- Collect all pending subtask parts
- If multiple: Promise.allSettled(subtasks.map(executeSubtask))
- If single: await executeSubtask(task) (preserves existing behavior)
- Compaction tasks still processed sequentially first
```

### Step 3.3: Abort propagation
- When parent session aborts, propagate to all child sessions
- Use `AbortController` per child, linked to parent's signal
- On parent abort: call `SessionPrompt.cancel()` for each active child

### Step 3.4: Update orchestrator prompt for parallel guidance
**File:** `packages/aboocode/src/agent/prompt/orchestrator.txt`

Add instructions:
- Use `delegate_tasks` when agents work on different files/features
- Use sequential `delegate_task` when later work depends on earlier results
- Use `depends_on` for partial ordering within parallel batches

---

## Phase 4: Verification

### Build & Run
```bash
cd packages/aboocode && bun install && bun run build
./dist/aboocode-darwin-x64/bin/aboo
```

### Test hot-reload
1. Start Aboocode TUI via `aboo`
2. Create `.aboocode/tool/test-tool.ts` with a simple tool definition
3. Verify it appears in available tools without restart
4. Modify the file → verify it reloads
5. Same for `.aboocode/skill/TEST-SKILL/SKILL.md` and `.aboocode/agents/custom.md`

### Test agent-team
1. Switch to orchestrator agent in TUI
2. Give a multi-file task: "Add user authentication with JWT"
3. Verify orchestrator calls `plan_team` → `add_agent` (writes `.aboocode/agents/<id>.md` files) → `finalize_team`
4. Verify real agent .md files appear on disk and hot-reload loads them into `Agent.list()`
5. Verify `delegate_task` dispatches to the **real specialized agent** (not a generic worker)
6. Verify `disband_team` deletes the .md files and agents disappear from the system

### Test parallel execution
1. In orchestrator mode, give a task with clearly independent subtasks
2. Verify `delegate_tasks` is used (check session children created concurrently)
3. Test with `depends_on` — verify ordering is respected
4. Test error case — one agent fails, others still complete

---

## Critical Files Summary

| File | Changes |
|------|---------|
| `packages/aboocode/package.json` | Rebrand to aboocode, bin → `aboo` |
| `packages/aboocode/src/config/config.ts` | `.opencode` → `.aboocode`, remove default provider |
| `packages/aboocode/src/file/watcher.ts` | Watch config subdirectories |
| `packages/aboocode/src/hot-reload/index.ts` | **NEW** — debounced reload coordinator (immediate mode for agents dir) |
| `packages/aboocode/src/tool/registry.ts` | Add reload(), register team tools |
| `packages/aboocode/src/skill/skill.ts` | Add reload() |
| `packages/aboocode/src/agent/agent.ts` | Add reload(), add orchestrator as built-in agent |
| `packages/aboocode/src/tool/team.ts` | **NEW** — 7 team tools (add_agent writes real .md files, disband_team deletes them) |
| `packages/aboocode/src/team/manager.ts` | **NEW** — team lifecycle tracker (staging → active → disbanded) |
| `packages/aboocode/src/team/knowledge-bridge.ts` | **NEW** — ported knowledge bridge |
| `packages/aboocode/src/agent/prompt/orchestrator.txt` | **NEW** — orchestrator system prompt |
| `packages/aboocode/src/session/prompt.ts` | Parallel subtask processing |
| `packages/aboocode/src/plugin/index.ts` | Remove default auth plugin |
| `packages/aboocode/src/cli/logo.ts` | ABOOCODE logo (ABOO left + CODE right) |
| `packages/aboocode/src/index.ts` | scriptName → `"aboo"` |
| `packages/aboocode/script/build.ts` | Output binary → `aboo` |

**Runtime-generated files** (created/deleted by team tools during orchestration):

| Pattern | Lifecycle |
|---------|-----------|
| `.aboocode/agents/<team-agent-id>.md` | Created by `add_agent`, loaded by hot-reload, used by `delegate_task`, deleted by `disband_team` |
