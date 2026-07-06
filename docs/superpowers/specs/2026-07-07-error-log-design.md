# Dedicated errors.log — Design

Date: 2026-07-07
Status: approved (design confirmed with user)

## Problem

Aboocode logs to a per-run timestamped file (`~/.local/share/aboocode/log/<ts>.log`)
that is truncated on start and auto-pruned (keeps the most recent handful). There
is no single place that persists *errors* across runs, so answering "what went
wrong recently?" means grepping rotated per-run logs. Runtime `session.error`
bus events surface to the TUI but are not durably aggregated anywhere.

## Decision

Add a dedicated, persistent `errors.log` that aggregates (a) every `WARN` and
`ERROR` line written through the `Log` namespace and (b) every `session.error`
bus event. It is an ADDITIVE sink — the main per-run log, the TUI display, and
the `session.error` event itself are all unchanged.

## Location & retention

- Path: `Global.Path.log/errors.log` (stable filename, alongside per-run logs).
- Persists across runs (append; NOT truncated on init, unlike the per-run log).
- Size-capped rotation: on `Log.init`, if `errors.log` exceeds **10 MB**, rename
  it to `errors.log.1` (replacing any existing `.1`), then start a fresh
  `errors.log`. One previous generation is retained.

## What it captures

1. **WARN + ERROR log lines.** In the `Log` namespace's `warn()` / `error()`
   methods, after the existing main-log `write(...)`, also append the same
   formatted line to the errors sink.
2. **`session.error` bus events.** A small bridge subscribes to
   `Session.Event.Error` and writes one structured line per event.

## Line format

Reuse the existing timestamp + tag-prefix + `formatError` cause-chain machinery.
Each errors.log line carries: ISO timestamp, level/source, `service`/tag prefix,
`sessionID` (when present), error `category` (when the payload is a classified
failure or a NamedError `name`), the message, and the `cause` chain (via the
existing `formatError`, depth-capped at 10).

- WARN/ERROR lines: identical to the main-log formatted line (level prefix +
  `build(message, extra)`), just teed to the errors sink.
- `session.error` lines: `ERROR source=session.error sessionID=<id>
  category=<error.name> <error.data.message> [Caused by: ...]`.

## Architecture (no circular dependency)

`src/util/log.ts` is a low-level util imported broadly; it must NOT import
`session`. Therefore:

- **WARN/ERROR tee + rotation + the write primitive** live IN `log.ts`
  (low-level, self-contained). `log.ts` gains: a second append stream for
  `errors.log`, size-rotation in `init`, a `recordError(entry)` public function
  that formats+writes a structured error line, and `errorFile()` returning the
  path.
- **The `session.error` → `recordError` bridge** lives HIGHER UP in a new module
  `src/session/error-log.ts` (`SessionErrorLog`), which may import `Bus`,
  `Session` (for the event definition), and `Log`. It exposes an idempotent
  `init()` that subscribes once. `log.ts` never depends on `session`.

## Wiring

`SessionErrorLog.init()` is called right after `Log.init(...)` at each process
entry point that initializes logging: the main CLI middleware
(`src/index.ts:67`) and the TUI worker (`src/cli/cmd/tui/worker.ts:14`). `init()`
is idempotent (guards a module-level `started` flag) so double-calls are safe.

## Error handling

All errors.log writes are best-effort: a failure to open/write the errors sink
must never throw into the caller or break the main log (mirror the existing
`.catch(() => {})` truncate pattern). If the errors stream can't be opened,
`recordError` and the tee become no-ops for that run.

## Testing

- WARN and ERROR log calls append to `errors.log`; DEBUG/INFO do not.
- `recordError` writes a structured line including `category` and the `cause`
  chain.
- `Log.init` rotates `errors.log` → `errors.log.1` when the existing file
  exceeds the 10 MB cap, and leaves it in place when under.
- The `SessionErrorLog` bridge, given a `session.error` event, produces an
  errors.log line with the sessionID and the error name/message; `init()` is
  idempotent (a second call does not double-subscribe).

## Out of scope (possible follow-ups)

- `aboocode logs` CLI subcommand to view/tail logs.
- Per-category error counters / rates.
- Remote/telemetry export (Aboocode ships no crash-reporting SDK by design).
