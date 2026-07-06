# Changelog

All notable changes to Aboocode are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.4] - 2026-07-07

### Added

- **Persistent `errors.log`.** A dedicated error log at
  `~/.local/share/aboocode/log/errors.log` aggregates every `WARN`/`ERROR` log
  line and every `session.error` event across runs (the per-run log is
  truncated on start and auto-pruned, so errors were previously hard to review
  after the fact). It rotates to `errors.log.1` past 10 MB and is fully
  additive — the per-run log, the TUI, and the `session.error` event are
  unchanged. All writes are best-effort and can never crash the app.

  Note: an error whose publish site also calls `log.error` appears as two
  lines — a human-readable tagged line (the tee) and a terse structured line
  (`source=session.error … category=<name>`); both framings are intentional.

## [0.11.3] - 2026-07-06

Registry-reload and workflow-accounting follow-up fixes.

### Fixed

- **`Skill.reload()` dropped bundled/MCP/config skills.** Reloading skills
  (which happens at runtime via hot-reload) re-scanned only on-disk sources and
  silently discarded bundled, MCP-prompt, `skills.paths`, and `skills.urls`
  skills until process restart. The reload path now rebuilds through the same
  shared builder `state()` uses, so every source is re-merged. (Twin of the
  0.11.1 `Command.reload()` fix.)
- **Workflow child token spend was excluded from the parent's total.** A
  `workflow()` composition recorded `tokens: 0` on the parent's journal row, so
  the parent's `tokens_total` omitted all child spend and resume budget seeding
  under-counted. Child spend now rolls up into the parent total; both the
  memo-hit and divergence resume paths are covered by tests.

## [0.11.2] - 2026-07-06

Bug-scan remediation: a four-agent scan surfaced ~18 issues; the confirmed ones
were fixed, and three planned fixes were reverted after review as false-positive
or unsafe. Each fix was individually reviewed plus a whole-branch review.

### Security / Permissions

- **`deny` could be bypassed by command ordering.** The permission prompt loop
  returned on the first pattern that needed an `ask`, so a later explicitly
  `deny`-ed pattern in the same request (e.g. `ls ; curl evil` under a
  `curl *: deny` rule) was never evaluated. Every pattern is now checked for
  `deny` before any prompt, and a config `deny` is absolute over a
  runtime-approved `allow`.
- **Task recursion guard.** The guard that stops a subagent from spawning
  further subagents now keys on an explicit `task` grant with a non-`deny`
  effective action, rather than mere rule presence — fixing both an
  explicitly-denied agent being mis-classified and (caught in whole-branch
  review) the default `*:allow` agents losing the guard entirely.

### Fixed

- **Retry ignored `Retry-After` and exponential backoff.** API errors were
  hard-coded to a 2s retry, making the `Retry-After` header parsing and backoff
  dead code; a 429 was hammered ~10× in ~20s. API errors now use the real
  backoff path, and an uncapped delay branch was capped.
- **Hang when cancelling a busy session.** A second prompt queued behind a busy
  session parked a callback that `cancel()` never settled, hanging that request
  forever. `cancel()` (and instance teardown) now reject queued callbacks.
- **Workflow concurrent-resume corruption (TOCTOU).** Two concurrent resumes of
  the same run could both proceed and double-write the journal / duplicate side
  effects. Resume now claims the run synchronously before any await; the claim
  is released on any pre-execution failure.
- **Workflow resume correctness.** Diverged calls no longer double-count the
  budget; transiently-failed calls re-run on resume instead of replaying as
  `null`; composed child workflows are memoized (keyed on the resolved script
  ref) so a parent resume skips completed children.
- **Claude Code remote MCP servers never connected.** SSE/HTTP servers imported
  from a Claude Code config mapped to unknown types and failed with a bogus
  "Unknown error"; they now map to `remote` and connect (StreamableHTTP → SSE
  fallback).
- **First-run database durability.** The JSON→SQLite migration left the shared
  connection at `PRAGMA synchronous = OFF` for the rest of the first-run
  process (corruption risk on power loss/kill); it now restores `NORMAL`.
- **OAuth cancel was a no-op** (looked up the wrong key) and background-task
  `kill` reported success before cancellation ran; both fixed.
- `$ARGUMENTS` in slash-command templates no longer mis-interprets `$&`/`$$`
  in user input; config `{file:X}` placeholders are replaced globally.

### Changed

- **Config precedence (behavior change):** project `.aboocode/` now correctly
  overrides home `~/.aboocode/` for all config keys, agents, skills, and
  commands (previously home won). Review-verified that plugin precedence is
  consistent under the new order.

### Reverted (planned, dropped after review)

- Bash classifier `ask`-enforcement — it double-prompted destructive commands
  and couldn't be made safe; the `dangerous → deny` hard floor is retained.
- A grep empty-line fix (the bug didn't reproduce against real ripgrep output)
  and an `edit` fuzzy `replaceAll` change (risked overwriting unrelated
  similarly-shaped blocks).

## [0.11.1] - 2026-07-06

### Added

- **`/workflow` slash command** (gated on `experimental.workflows`) to launch,
  resume, author, or list dynamic workflows from the prompt line.

### Fixed

- **`Command.reload()` dropped ~30 bundled commands.** After any config reload,
  only 4 of ~34 built-in slash commands survived (`/compact`, `/undo`,
  `/model`, `/help`, etc. vanished until restart). Reload now rebuilds the full
  registry via a shared builder.

## [0.11.0] - 2026-07-05

Two large workstreams: session-harness reliability for long/complex tasks, and
graduation of the dynamic workflow engine.

### Added — Session harness reliability

- Step bounding (`DEFAULT_MAX_STEPS`) when `agent.steps` is unset.
- Periodic todo-list re-anchoring reminders for long tasks.
- Circuit-breaker on repeated auto-compaction failures; capped stop-hook blocks.
- Token budget derived from exact API usage instead of a character heuristic.
- Micro-compaction gated on cache coldness / context pressure.
- Sliding-window detection of alternating "doom loops".
- Model fallback after repeated failures.

### Added — Dynamic workflow engine

- `workflow()` composition (one nesting level; shares budget, concurrency caps,
  and abort signal with a dedicated journal row).
- Worktree isolation for workflow agents; headless permission posture for
  spawned child sessions.
- Abort wired through engine and spawn with persisted `stopped` status;
  completion notification carries the run's return value.
- Journal-based resume: budget seeded from persisted tokens, `invalidateFrom`
  decrements the running total, resume refuses missing/still-running runs and
  recovers crashed runs.

## [0.10.0] - prior baseline

Baseline release preceding the changes recorded above.

[0.11.4]: https://github.com/cytsaiap-xyz/aboocode/compare/v0.11.3...v0.11.4
[0.11.3]: https://github.com/cytsaiap-xyz/aboocode/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/cytsaiap-xyz/aboocode/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/cytsaiap-xyz/aboocode/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/cytsaiap-xyz/aboocode/compare/v0.10.0...v0.11.0
