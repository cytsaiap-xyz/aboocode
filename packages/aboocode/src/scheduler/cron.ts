/**
 * Minimal cron expression parser + next-fire-time computation.
 *
 * Phase 12: supports the 5-field POSIX cron syntax — minute, hour,
 * day-of-month, month, day-of-week. Each field may be:
 *   - `*`              every value
 *   - literal number   e.g. `5`
 *   - list             e.g. `1,3,5`
 *   - range            e.g. `1-5`
 *   - step             e.g. `*\/15` (every 15)
 *
 * Also supports:
 *   - `@every Ns|Nm|Nh` for interval-style scheduling
 *   - An ISO8601 timestamp for one-shot wakeups (nextFire returns that
 *     instant exactly once, then Infinity)
 *
 * We add jitter (±10% of the interval) when computing the next fire
 * time to avoid fleet-wide :00 / :30 clustering, matching the pattern
 * described in the Deep-Dive for Claude Code's scheduler.
 */

const JITTER_PCT = 0.1

export namespace Cron {
  export function isCronExpression(s: string): boolean {
    return s.trim().split(/\s+/).length === 5
  }

  export function isIntervalExpression(s: string): s is `@every ${string}` {
    return /^@every\s+\d+(s|m|h)$/.test(s.trim())
  }

  export function isIsoTimestamp(s: string): boolean {
    const d = new Date(s)
    return !Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(s)
  }

  export function validate(schedule: string): void {
    const s = schedule.trim()
    if (isIsoTimestamp(s)) return
    if (isIntervalExpression(s)) return
    if (!isCronExpression(s)) {
      throw new Error(
        `Invalid schedule "${schedule}". Expected: 5-field cron ("*/15 * * * *"), ISO timestamp ("2026-04-24T12:00:00Z"), or interval ("@every 30m")`,
      )
    }
    const fields = s.split(/\s+/)
    const specs: [string, number, number][] = [
      ["minute", 0, 59],
      ["hour", 0, 23],
      ["day-of-month", 1, 31],
      ["month", 1, 12],
      ["day-of-week", 0, 6],
    ]
    for (let i = 0; i < 5; i++) parseField(fields[i], specs[i][1], specs[i][2], specs[i][0])
  }

  /**
   * Compute the next time after `now` this schedule fires, in ms since
   * epoch. Returns Infinity if the schedule is a one-shot timestamp in
   * the past.
   */
  export function nextFire(schedule: string, now: number = Date.now()): number {
    const s = schedule.trim()
    if (isIsoTimestamp(s)) {
      const t = new Date(s).getTime()
      return t > now ? t : Infinity
    }
    if (isIntervalExpression(s)) {
      const m = /^@every\s+(\d+)(s|m|h)$/.exec(s)!
      const n = Number(m[1])
      const unit = m[2]
      const base = unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000
      const interval = n * base
      return now + applyJitter(interval)
    }
    // 5-field cron
    return nextCronFire(s, now)
  }

  function applyJitter(intervalMs: number): number {
    const maxJitter = Math.floor(intervalMs * JITTER_PCT)
    if (maxJitter <= 0) return intervalMs
    const jitter = Math.floor(Math.random() * (2 * maxJitter + 1)) - maxJitter
    return Math.max(1000, intervalMs + jitter)
  }

  function parseField(raw: string, min: number, max: number, name: string): Set<number> {
    const out = new Set<number>()
    for (const part of raw.split(",")) {
      if (part === "*") {
        for (let v = min; v <= max; v++) out.add(v)
        continue
      }
      const stepMatch = /^(.*)\/(\d+)$/.exec(part)
      if (stepMatch) {
        const base = stepMatch[1]
        const step = Number(stepMatch[2])
        if (step <= 0) throw new Error(`Invalid step in ${name}: ${part}`)
        const range = base === "*" ? [min, max] : rangeOf(base, min, max, name)
        for (let v = range[0]; v <= range[1]; v += step) out.add(v)
        continue
      }
      const range = rangeOf(part, min, max, name)
      for (let v = range[0]; v <= range[1]; v++) out.add(v)
    }
    return out
  }

  function rangeOf(part: string, min: number, max: number, name: string): [number, number] {
    const hyphen = part.split("-")
    if (hyphen.length === 2) {
      const lo = Number(hyphen[0])
      const hi = Number(hyphen[1])
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`Invalid range in ${name}: ${part}`)
      }
      return [lo, hi]
    }
    const n = Number(part)
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`Invalid ${name} value: ${part} (range ${min}-${max})`)
    }
    return [n, n]
  }

  function nextCronFire(expr: string, now: number): number {
    const [minF, hourF, domF, monF, dowF] = expr.split(/\s+/)
    const minutes = parseField(minF, 0, 59, "minute")
    const hours = parseField(hourF, 0, 23, "hour")
    const doms = parseField(domF, 1, 31, "day-of-month")
    const months = parseField(monF, 1, 12, "month")
    const dows = parseField(dowF, 0, 6, "day-of-week")

    // Step forward minute-by-minute up to a year. Inefficient but dead
    // simple and correct; this is not on a hot path.
    const MAX_STEPS = 366 * 24 * 60
    const base = new Date(now)
    base.setSeconds(0, 0)
    base.setMinutes(base.getMinutes() + 1)
    for (let i = 0; i < MAX_STEPS; i++) {
      const d = new Date(base.getTime() + i * 60_000)
      if (
        minutes.has(d.getMinutes()) &&
        hours.has(d.getHours()) &&
        months.has(d.getMonth() + 1) &&
        doms.has(d.getDate()) &&
        dows.has(d.getDay())
      ) {
        return d.getTime() + applyJitter(0) // no jitter for cron; applyJitter(0) is a no-op
      }
    }
    return Infinity
  }
}
