/**
 * Cron supervisor — polls the durable store and fires due jobs.
 *
 * Phase 12 (closing the stub): runs a single setInterval loop that scans
 * `CronStore.list()` once a minute, computes `Cron.nextFire()` for each
 * job, and emits a `cron.fire` Bus event for any job whose next-fire
 * time has elapsed since the previous tick. The session loop subscribes
 * to that event and surfaces the prompt as a normal user message.
 *
 * Design decisions:
 *   - In-process supervisor: there's no separate daemon. The runner
 *     starts when the harness boots and stops on shutdown. Durable jobs
 *     persist across restarts; if a job's fire window was missed while
 *     the process was down, it fires at most once on the next boot
 *     (catch-up), then resumes its normal cadence.
 *   - Polling cadence: 60s. Jitter is per-job (already in `Cron`), not
 *     per-tick. A 60s tick is fine for cron expressions whose finest
 *     granularity is 1 minute.
 *   - One-shot jobs (ISO timestamps) are removed after firing.
 *   - Recurring jobs update `lastFiredAt`; their next fire is computed
 *     fresh on each tick from the schedule expression.
 */

import { CronStore, type CronJob } from "./cron-store"
import { Cron } from "./cron"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"
import { z } from "zod"

const log = Log.create({ service: "scheduler.cron-runner" })

const POLL_INTERVAL_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null
let started = false

export namespace CronRunner {
  export const Event = {
    Fired: BusEvent.define(
      "cron.fire",
      z.object({
        id: z.string(),
        sessionID: z.string().optional(),
        prompt: z.string(),
        firedAt: z.number(),
      }),
    ),
  }

  /**
   * Boot the supervisor. Idempotent — safe to call multiple times.
   */
  export function start(): void {
    if (started) return
    started = true
    log.info("cron runner starting", { pollIntervalMs: POLL_INTERVAL_MS })
    // Fire an immediate tick so jobs whose fire-window passed during
    // downtime are caught on boot, not after a 60s delay.
    void tick()
    timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    timer.unref?.()
  }

  export function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    started = false
  }

  async function tick(): Promise<void> {
    const tickStart = Date.now()
    try {
      const jobs = await CronStore.list()
      let firedCount = 0
      for (const job of jobs) {
        if (await isDue(job, tickStart)) {
          await fire(job, tickStart)
          firedCount++
        }
      }
      log.info("cron tick", {
        jobs: jobs.length,
        fired: firedCount,
        durationMs: Date.now() - tickStart,
      })
    } catch (e) {
      log.warn("cron tick failed", { error: e, durationMs: Date.now() - tickStart })
    }
  }

  /**
   * Decide whether a job is due to fire right now.
   *
   * Three schedule kinds, three rules:
   *
   *   ISO one-shot:    fire iff (not yet fired) AND (timestamp <= now).
   *                    `Cron.nextFire(iso, baseline)` returns Infinity when
   *                    `iso < baseline`, which would *block* catch-up of
   *                    a past timestamp on first boot — so handle ISOs
   *                    directly here instead of routing through nextFire.
   *
   *   @every interval: fire iff (now - baseline) >= interval. Computed
   *                    deterministically from the interval (no jitter on
   *                    the comparison) to avoid early firing when the
   *                    runner re-rolls jitter on every tick.
   *
   *   5-field cron:    fire iff `Cron.nextFire(expr, baseline) <= now`.
   *                    The cron parser walks forward from baseline to
   *                    the next matching minute, which is the correct
   *                    semantics here.
   */
  async function isDue(job: CronJob, now: number): Promise<boolean> {
    if (Cron.isIsoTimestamp(job.schedule)) {
      if (job.lastFiredAt) return false // already fired; will be pruned by fire()
      const fireAt = new Date(job.schedule).getTime()
      return fireAt <= now
    }
    if (Cron.isIntervalExpression(job.schedule)) {
      const baseline = job.lastFiredAt ?? job.createdAt
      const intervalMs = parseIntervalMs(job.schedule)
      if (intervalMs === null) return false
      // Honor a worst-case negative-jitter floor so a freshly-recomputed
      // jitter can't cause early firing across ticks.
      const minWait = Math.floor(intervalMs * 0.9)
      return now - baseline >= minWait
    }
    // 5-field cron
    const baseline = job.lastFiredAt ?? job.createdAt
    const next = Cron.nextFire(job.schedule, baseline)
    return Number.isFinite(next) && next <= now
  }

  function parseIntervalMs(schedule: string): number | null {
    const m = /^@every\s+(\d+)(s|m|h)$/.exec(schedule.trim())
    if (!m) return null
    const n = Number(m[1])
    const unit = m[2]
    return n * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000)
  }

  async function fire(job: CronJob, now: number): Promise<void> {
    log.info("cron firing", { id: job.id, schedule: job.schedule })
    Bus.publish(Event.Fired, {
      id: job.id,
      sessionID: job.sessionID,
      prompt: job.prompt,
      firedAt: now,
    })
    // One-shot jobs (ISO timestamp schedules) are pruned after firing.
    // Recurring jobs just record lastFiredAt; the next tick computes the
    // following fire time.
    if (Cron.isIsoTimestamp(job.schedule)) {
      await CronStore.remove(job.id)
      return
    }
    await CronStore.markFired(job.id, now)
  }

  /** Test helper. */
  export async function _tickForTests(): Promise<void> {
    await tick()
  }
}
