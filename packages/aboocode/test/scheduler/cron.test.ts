import { describe, expect, test } from "bun:test"
import { Cron } from "@/scheduler/cron"

describe("Cron.validate", () => {
  test("accepts well-formed cron expressions", () => {
    expect(() => Cron.validate("* * * * *")).not.toThrow()
    expect(() => Cron.validate("0 9 * * 1-5")).not.toThrow()
    expect(() => Cron.validate("*/15 * * * *")).not.toThrow()
    expect(() => Cron.validate("0,15,30,45 * * * *")).not.toThrow()
  })

  test("accepts intervals and ISO timestamps", () => {
    expect(() => Cron.validate("@every 30s")).not.toThrow()
    expect(() => Cron.validate("@every 5m")).not.toThrow()
    expect(() => Cron.validate("@every 2h")).not.toThrow()
    expect(() => Cron.validate("2030-01-01T12:00:00Z")).not.toThrow()
  })

  test("rejects malformed expressions", () => {
    expect(() => Cron.validate("not-a-cron")).toThrow()
    expect(() => Cron.validate("60 * * * *")).toThrow() // minute > 59
    expect(() => Cron.validate("* 24 * * *")).toThrow() // hour > 23
    expect(() => Cron.validate("* * 32 * *")).toThrow() // day > 31
    expect(() => Cron.validate("* * * 13 *")).toThrow() // month > 12
    expect(() => Cron.validate("* * * * 7")).toThrow() // dow > 6
    expect(() => Cron.validate("*/0 * * * *")).toThrow() // step 0
  })

  test("rejects @every with bad units", () => {
    expect(() => Cron.validate("@every 30")).toThrow()
    expect(() => Cron.validate("@every 30d")).toThrow()
  })
})

describe("Cron.isIsoTimestamp", () => {
  test("accepts well-formed ISO", () => {
    expect(Cron.isIsoTimestamp("2026-04-26T12:00:00Z")).toBe(true)
    expect(Cron.isIsoTimestamp("2026-04-26T12:00:00.000Z")).toBe(true)
  })

  test("rejects non-ISO date-like strings", () => {
    expect(Cron.isIsoTimestamp("2026-04-26")).toBe(false) // no time portion
    expect(Cron.isIsoTimestamp("not-a-date")).toBe(false)
  })
})

describe("Cron.nextFire — 5-field cron", () => {
  test("'* * * * *' fires next minute boundary strictly after now", () => {
    const now = new Date("2026-04-26T10:00:30Z").getTime()
    const next = Cron.nextFire("* * * * *", now)
    // Next minute after 10:00:30 is 10:01:00 (in local TZ — but the
    // expression matches every minute, so it's the next whole minute).
    const d = new Date(next)
    expect(d.getSeconds()).toBe(0)
    // Must be ≥1 minute and ≤2 minutes ahead (minute boundary depends on TZ)
    expect(next).toBeGreaterThan(now)
    expect(next - now).toBeLessThanOrEqual(60_000)
  })

  test("'*/15 * * * *' produces minute-multiples of 15", () => {
    const now = new Date("2026-04-26T10:01:00Z").getTime()
    const next = Cron.nextFire("*/15 * * * *", now)
    const d = new Date(next)
    expect([0, 15, 30, 45]).toContain(d.getMinutes())
  })

  test("strictly after baseline — no double-fire on same minute", () => {
    const baseline = new Date("2026-04-26T10:15:00Z").getTime()
    const next = Cron.nextFire("*/15 * * * *", baseline)
    expect(next).toBeGreaterThan(baseline)
    // Next 15-minute slot after 10:15 is 10:30
    expect(next - baseline).toBeGreaterThanOrEqual(15 * 60_000)
  })
})

describe("Cron.nextFire — ISO one-shot", () => {
  test("future ISO returns the timestamp itself", () => {
    const fire = new Date("2026-04-26T15:00:00Z").getTime()
    const now = new Date("2026-04-26T14:30:00Z").getTime()
    expect(Cron.nextFire("2026-04-26T15:00:00Z", now)).toBe(fire)
  })

  test("past ISO returns Infinity", () => {
    const now = new Date("2026-04-26T16:00:00Z").getTime()
    expect(Cron.nextFire("2026-04-26T15:00:00Z", now)).toBe(Infinity)
  })

  test("ISO equal to now returns Infinity (strictly future)", () => {
    const fire = new Date("2026-04-26T15:00:00Z").getTime()
    expect(Cron.nextFire("2026-04-26T15:00:00Z", fire)).toBe(Infinity)
  })
})

describe("Cron.nextFire — @every interval", () => {
  test("'@every 30s' is approximately baseline + 30s ± jitter", () => {
    const baseline = 1_000_000_000_000
    const samples: number[] = []
    for (let i = 0; i < 50; i++) {
      samples.push(Cron.nextFire("@every 30s", baseline) - baseline)
    }
    const min = Math.min(...samples)
    const max = Math.max(...samples)
    // 30s ± 10% jitter → range [27s, 33s]
    expect(min).toBeGreaterThanOrEqual(27_000)
    expect(max).toBeLessThanOrEqual(33_000)
  })

  test("'@every 5m' is roughly 5 minutes ahead", () => {
    const baseline = 1_000_000_000_000
    const next = Cron.nextFire("@every 5m", baseline)
    const elapsed = next - baseline
    expect(elapsed).toBeGreaterThanOrEqual(4.5 * 60_000)
    expect(elapsed).toBeLessThanOrEqual(5.5 * 60_000)
  })
})
