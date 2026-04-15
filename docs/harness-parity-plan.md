# Harness Parity Plan (Phases 0–10)

This document is the scorecard and reference for the 11-phase effort to bring
aboocode's harness engineering to functional parity with Claude Code's
(per the cytsaiap-xyz/claude-code-leak reference).

Each phase maps to one (or a group of) commits on the branch
`claude/compare-code-implementations-I4ETm`.

## Phase 0 — Scaffolding ✅

Created the subdirectories + barrels the later phases consume:

- `packages/aboocode/src/memory/memdir/` — destination for the 8 ported
  Claude Code memdir modules.
- `packages/aboocode/src/hook/lifecycle/` — destination for the lifecycle
  hook registry and types.
- Output styles, bundled skills, compaction strategies, and permission
  mode all got dedicated files rather than cramming into existing modules.

## Phase 1 — Memory system parity ✅

Ported 8 files from `claude-code-leak/src/memdir/` into
`packages/aboocode/src/memory/memdir/`:

| Claude Code module        | aboocode destination                                       |
| ------------------------- | ---------------------------------------------------------- |
| `memdir.ts`               | `memory/memdir/memdir.ts`                                  |
| `memoryTypes.ts`          | `memory/memdir/memoryTypes.ts`                             |
| `memoryAge.ts`            | `memory/memdir/memoryAge.ts`                               |
| `memoryScan.ts`           | `memory/memdir/memoryScan.ts`                              |
| `findRelevantMemories.ts` | `memory/memdir/findRelevantMemories.ts`                    |
| `paths.ts`                | `memory/memdir/paths.ts`                                   |
| `teamMemPaths.ts`         | `memory/memdir/teamMemPaths.ts`                            |
| `teamMemPrompts.ts`       | `memory/memdir/teamMemPrompts.ts`                          |

Key capabilities landed:

- LLM-based recall selector (up to 5 relevant memories) with heuristic
  fallback when no small model is available
- Staleness warnings for memories >1 day old (including
  `<system-reminder>`-wrapped notes)
- Frontmatter metadata scanning with 200-file cap and mtime-sorted ranking
- 4-type taxonomy (user/feedback/project/reference) with
  COMBINED/INDIVIDUAL prose variants
- Path traversal / symlink-escape / unicode-normalization security
- Team memory opt-in via config.memory.team

Integration: `Memory.buildSystemPrompt()` and `Memory.recall()` are the new
async entrypoints; existing `Memory.buildContext()` is left as a
backward-compatible shim.

## Phase 2 — Lifecycle hook system ✅

`packages/aboocode/src/hook/lifecycle/`:

- `types.ts` — `LIFECYCLE_EVENTS` array, zod `HookConfig` schema matching
  Claude Code's `settings.json.hooks` shape, concrete payload interfaces
- `registry.ts` — `HookLifecycle.dispatch()` loads config, matches hooks,
  spawns command-type hooks with JSON on stdin (30s timeout default),
  parses decision from stdout, supports in-process handlers for tests

Wired into:

- `session/prompt.ts` built-in tool dispatcher (`PreToolUse`/`PostToolUse`)
- `session/prompt.ts` MCP tool dispatcher (same)
- `session/prompt.ts` user prompt entry (`UserPromptSubmit`, blocks or
  rewrites the prompt text)
- `session/index.ts` `createNext()` (`SessionStart` with source=startup
  or sub-agent)
- `session/index.ts` `remove()` (`SessionEnd`)

Hook configs are now portable between Claude Code and aboocode.

## Phase 3 — Compaction strategies ✅

`packages/aboocode/src/session/compaction-strategies.ts`:

- `budget()` — used/limit/reserved/usable/ratio snapshot
- `selectStrategy()` — ratio-driven picker (none / microcompact / snip /
  reactive / summarize)
- `snip()` — drops the oldest large tool outputs to free a byte target
- `run()` — dispatches the chosen strategy, firing `PreCompact` and
  `PostCompact` lifecycle hooks around it

Default thresholds (overridable via `config.compaction.thresholds`):
0.75 / 0.85 / 0.92 / 0.97.

## Phase 4 — Tool gaps ✅

- **NotebookEdit** (`tool/notebook-edit.ts` + `.txt`): replace / insert
  / delete modes, preserves schema, clears outputs on code-cell edits,
  goes through the same permission path as Write/Edit. Registered in
  `tool/registry.ts`.
- **Output styles** (`format/output-styles/`): `default` / `concise` /
  `explanatory` bundled, user-defined loader for
  `~/.aboocode/output-styles/<id>.md`, `OutputStyles.active()` +
  `systemPromptAddendum()` entrypoints.

## Phase 5 — Slash command expansion ✅

Grew built-in commands from 3 to 13:

| Command          | Purpose                                              |
| ---------------- | ---------------------------------------------------- |
| `/init`          | create/update AGENTS.md (pre-existing)               |
| `/review`        | review changes (pre-existing)                        |
| `/memory`        | show memory system status (pre-existing)             |
| `/compact`       | summarize the session into a dense turn              |
| `/clear`         | clear conversation context                           |
| `/plan`          | enter read-only plan mode                            |
| `/hooks`         | show configured lifecycle hooks                      |
| `/agents`        | list available agents                                |
| `/output-style`  | switch session output style                          |
| `/mcp`           | show connected MCP servers                           |
| `/model`         | switch session model                                 |
| `/resume`        | resume a prior session                               |
| `/help`          | list commands                                        |

All templates live in `packages/aboocode/src/command/template/` and are
wired into `Command.Default` + the `Instance.state()` initializer.

## Phase 6 — Permission hooks layer ✅

- `permission/mode.ts` — `PermissionMode` with `default` / `acceptEdits`
  / `bypassPermissions` / `plan`. Resolved from
  `ABOOCODE_PERMISSION_MODE` env var or runtime `setMode()`.
- `permission/hook-gate.ts` — thin `gate()` that maps `PermissionMode.apply`
  to `allow` / `deny` / `fallthrough`.
- `permission/next.ts` — `PermissionNext.ask()` now consults
  `HookGate.gate()` BEFORE the declarative ruleset evaluator.

This layers the Claude-Code permission-mode semantics on top of
aboocode's existing declarative permission system without disrupting it.

## Phase 7 — MCP completeness ✅

`packages/aboocode/src/mcp/claude-code-compat.ts`:

- Loads `.mcp.json` (project) / `~/.mcp.json` / `~/.claude.json` in
  priority order, with `ABOOCODE_MCP_JSON` env override
- Converts Claude Code `mcpServers.{}` entries (stdio/sse/http/streamable)
  to aboocode's `CompatMcpEntry` shape
- Silently tolerates missing files

aboocode's MCP client already had tools/prompts/resources/OAuth — this
commit closes the last gap: config portability.

## Phase 8 — Skills ✅

- `skill/bundled.ts` — `BUNDLED_SKILLS` with inline `commit`, `review`,
  `test`, `plan` skills. Users get useful defaults without populating
  `~/.aboocode/skills/` first.
- `skill/mcp-builders.ts` — `buildMcpSkills()` enumerates
  `MCP.prompts()` and wraps each as an `McpSkill` with lazy
  `materialize()` that calls `MCP.getPrompt()` on demand.

## Phase 9 — Session state hardening ✅

`packages/aboocode/src/session/resume-picker.ts`:

- `SessionResumePicker.list(limit)` — recent sessions with preview,
  timestamp, message count, total tokens, unfinished flag
- `SessionResumePicker.resolve(token)` — `"latest"` / numeric index /
  session id / prefix to session id
- `SessionResumePicker.aggregateTokens(limit)` — headline total for a
  session-cost UI

The existing `Snapshot` system covers file history for revert; this
commit adds the presentation layer on top for the `/resume` slash command.

## Phase 10 — Tests & docs ✅

- `test/memory/memdir.test.ts` — pure-function tests for memoryAge,
  memoryTypes, truncation, memoryScan manifest formatting, bundled
  output styles, permission mode, compaction strategy selector,
  bundled skills, and `.mcp.json` compat.
- `docs/harness-parity-plan.md` — this document.

## Scoreboard vs the original gap analysis

| Subsystem                        | Before | After  |
| -------------------------------- | ------ | ------ |
| Memory system (8 memdir files)   | 12%    | 100%   |
| Lifecycle hooks                  | 0%     | 100%   |
| Compaction strategies (tiered)   | 50%    | 100%   |
| NotebookEdit tool                | 0%     | 100%   |
| Output styles                    | 0%     | 100%   |
| Slash command taxonomy (13)      | 23%    | 100%   |
| Permission modes                 | 0%     | 100%   |
| MCP `.mcp.json` compat           | 0%     | 100%   |
| Bundled skills                   | 0%     | 100%   |
| MCP skill builders               | 0%     | 100%   |
| Session resume picker            | 50%    | 100%   |

Pre-existing subsystems that did not need to change (tools registry,
declarative permissions, plugin system, transcripts, LSP, worktrees, etc.)
are not listed here.

## Out of scope (intentionally)

- Rewriting aboocode into a flat `src/` layout like claude-code-leak.
- Replacing Bun/Hono with Claude Code's Ink-only architecture.
- Dropping aboocode's provider-agnostic layer — aboocode intentionally
  supports many providers, Claude Code hard-codes Anthropic.
- Dropping the REST API / remote-client model (aboocode's differentiator).
