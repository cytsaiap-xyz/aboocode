/**
 * Memory staleness helpers — ported from claude-code-leak/src/memdir/memoryAge.ts.
 *
 * Raw ISO timestamps don't cue staleness reasoning in LLMs; "47 days ago"
 * does. These helpers render mtimeMs into human-readable ages and return
 * system-reminder–wrapped caveats that get inlined into memory recalls.
 */

/**
 * Days elapsed since mtime. Floor-rounded — 0 for today, 1 for yesterday,
 * 2+ for older. Negative inputs (future mtime, clock skew) clamp to 0.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/**
 * Human-readable age string. "today" / "yesterday" / "N days ago".
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return "today"
  if (d === 1) return "yesterday"
  return `${d} days ago`
}

/**
 * Plain-text staleness caveat for memories >1 day old. Returns "" for
 * fresh (today/yesterday) memories — warning there is noise.
 *
 * Use this when the consumer provides its own wrapping (e.g. a message
 * builder wraps results in a <system-reminder> block).
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ""
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/**
 * Per-memory staleness note wrapped in <system-reminder> tags. Returns ""
 * for memories ≤1 day old. Use this for callers that don't add their own
 * system-reminder wrapper.
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (!text) return ""
  return `<system-reminder>${text}</system-reminder>\n`
}
