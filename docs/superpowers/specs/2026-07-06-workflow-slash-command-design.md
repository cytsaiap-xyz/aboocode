# /workflow Slash Command — Design

Date: 2026-07-06
Status: approved (brainstormed with user; approach A of A/B/C)

## Problem

The dynamic workflow engine (behind `experimental.workflows`) is reachable only as a
model tool: the agent decides to call it, or the user asks in prose. There is no
first-class entry point. Users want `/workflow …` to launch, resume, and discover
workflows directly from the prompt line.

## Decision

Add `workflow` as a **bundled template command** — the same mechanism as the 33
existing built-ins (`src/command/index.ts` registry + `src/command/template/*.txt`).
The text after `/workflow` is substituted into the template's `$ARGUMENTS`
placeholder (`session/prompt.ts:2444-2447`) and the expanded template becomes the
user message; the model routes by argument shape and calls the `workflow` tool.

Rejected alternatives:
- **B — native dispatch** (TUI/server intercepts `/workflow` and calls
  `WorkflowRun.start` directly): zero-latency and deterministic, but breaks the
  "command = template" architecture, needs special-case dispatch/permission paths,
  and still needs the model for the natural-language case.
- **C — hybrid A+B**: full capability, full B complexity. Not warranted; launch
  latency is negligible against multi-minute background runs.

## Behavior

`/workflow $ARGUMENTS` routes by shape (routing logic lives IN THE TEMPLATE TEXT,
interpreted by the model — no TUI parser):

1. Starts with `resume ` → extract runId, call the workflow tool with
   `resumeFromRunId`.
2. Is an existing file path, or `<name>` where `.aboocode/workflows/<name>.js`
   exists in the project → call the tool with `scriptPath` (execute as-is; do not
   rewrite the script).
3. Any other non-empty text → treat as a task description: author a workflow script
   that satisfies it (respecting the meta block + determinism rules from the tool
   description) and run it.
4. Empty → list scripts in `.aboocode/workflows/` (if any) plus usage examples for
   the three forms above; do NOT execute anything.

## Components

1. **Create `src/command/template/workflow.txt`** — template implementing the
   routing rules above, with `$ARGUMENTS` embedded in an `<arguments>` block.
2. **Register in `src/command/index.ts`** — `Default.WORKFLOW: "workflow"`; the
   registry entry is added **only when `config.experimental?.workflows === true`**
   (same gate as the tool registration in `tool/registry.ts:198`), so `/workflow`
   never appears in autocomplete while the engine is disabled. The registry `state`
   already has `cfg` in scope for conditional insertion.
3. **Fix stale tool doc** (bundled here since it misleads the same routing):
   `src/workflow/tool.txt` still says `workflow(ref, args) (composition not yet
   available)` — replace with the shipped semantics (one nesting level; name refs
   resolve from `.aboocode/workflows/<name>.js`).

## Error handling

None new. Meta-parse failures, permission asks (`workflow` permission at the tool
boundary), abort, and background completion notification are all existing tool
behavior. The template only shapes the request.

## Testing

- Registry: with `experimental.workflows: true`, command `workflow` exists, source
  `"command"`, hints include `$ARGUMENTS`; with the flag off/absent, it is absent.
  (Follow existing command/config test patterns; `tmpdir` + `Instance.provide`
  with a config fixture.)
- Template content: assert the four routing rules' key phrases exist (resume /
  scriptPath / author / list-on-empty) so a template edit can't silently drop one.

## Out of scope

- `/workflow list` as a separate subcommand (empty-argument listing covers it).
- Native (model-bypassing) dispatch — revisit only if launch latency becomes a
  real complaint.
- Publishing a release with this change (separate decision).
