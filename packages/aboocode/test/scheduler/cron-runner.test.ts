import { describe, expect, test } from "bun:test"
import { CronStore } from "@/scheduler/cron-store"
import { CronRunner } from "@/scheduler/cron-runner"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { tmpdir } from "../fixture/fixture"

async function withRunner(fn: (fired: string[]) => Promise<void>): Promise<void> {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await CronStore._resetForTests()
      const fired: string[] = []
      const unsub = Bus.subscribe(CronRunner.Event.Fired, (e) => {
        fired.push(e.properties.id)
      })
      try {
        await fn(fired)
      } finally {
        unsub()
        await CronStore._resetForTests()
        await Instance.dispose()
      }
    },
  })
}

describe("CronRunner — firing semantics", () => {
  test("ISO one-shot in the past fires once, then is removed", async () => {
    await withRunner(async (fired) => {
      const past = new Date(Date.now() - 60 * 60_000).toISOString()
      const job = await CronStore.add({
        id: "iso-past",
        schedule: past,
        prompt: "wake up",
        durable: true,
        metadata: {},
      })
      await CronRunner._tickForTests()
      expect(fired).toContain(job.id)
      const after = await CronStore.list()
      expect(after.find((j) => j.id === "iso-past")).toBeUndefined()
      // Second tick — already pruned, should not fire again.
      await CronRunner._tickForTests()
      expect(fired.filter((id) => id === "iso-past")).toHaveLength(1)
    })
  })

  test("ISO one-shot in the future does NOT fire", async () => {
    await withRunner(async (fired) => {
      const future = new Date(Date.now() + 60 * 60_000).toISOString()
      await CronStore.add({
        id: "iso-future",
        schedule: future,
        prompt: "later",
        durable: true,
        metadata: {},
      })
      await CronRunner._tickForTests()
      expect(fired).not.toContain("iso-future")
      const after = await CronStore.list()
      expect(after.find((j) => j.id === "iso-future")).toBeDefined()
    })
  })

  test("recurring '* * * * *' just-created does NOT fire on first tick (next minute is in the future)", async () => {
    await withRunner(async (fired) => {
      await CronStore.add({
        id: "every-min",
        schedule: "* * * * *",
        prompt: "tick",
        durable: true,
        metadata: {},
      })
      await CronRunner._tickForTests()
      expect(fired).not.toContain("every-min")
    })
  })

  test("after firing, lastFiredAt is set so the same one-shot doesn't double-fire", async () => {
    await withRunner(async (fired) => {
      const past = new Date(Date.now() - 5 * 60_000).toISOString()
      await CronStore.add({
        id: "fires-once",
        schedule: past,
        prompt: "wake",
        durable: true,
        metadata: {},
      })
      await CronRunner._tickForTests()
      expect(fired).toContain("fires-once")
      await CronRunner._tickForTests()
      expect(fired.filter((id) => id === "fires-once")).toHaveLength(1)
    })
  })

  test("interval job just-created does NOT fire before the interval elapses", async () => {
    // Even with worst-case negative jitter (-10%), a freshly-added
    // @every 30s job created `now` should not fire on a tick at `now+epsilon`.
    await withRunner(async (fired) => {
      await CronStore.add({
        id: "interval-job",
        schedule: "@every 30s",
        prompt: "tick",
        durable: true,
        metadata: {},
      })
      await CronRunner._tickForTests()
      expect(fired).not.toContain("interval-job")
    })
  })

  test("interval job WITH backdated lastFiredAt fires when interval has elapsed", async () => {
    await withRunner(async (fired) => {
      const job = await CronStore.add({
        id: "interval-overdue",
        schedule: "@every 30s",
        prompt: "tick",
        durable: true,
        metadata: {},
      })
      // Backdate so the next-fire window has elapsed.
      await CronStore.markFired(job.id, Date.now() - 60_000)
      await CronRunner._tickForTests()
      expect(fired).toContain("interval-overdue")
    })
  })

  test("ISO one-shot in the past, after firing, removes the job (no re-fire on subsequent ticks)", async () => {
    await withRunner(async (fired) => {
      const past = new Date(Date.now() - 5 * 60_000).toISOString()
      await CronStore.add({
        id: "one-shot-past",
        schedule: past,
        prompt: "wake",
        durable: true,
        metadata: {},
      })
      await CronRunner._tickForTests()
      expect(fired).toContain("one-shot-past")
      // Job removed from the store
      expect((await CronStore.list()).find((j) => j.id === "one-shot-past")).toBeUndefined()
      await CronRunner._tickForTests()
      await CronRunner._tickForTests()
      expect(fired.filter((id) => id === "one-shot-past")).toHaveLength(1)
    })
  })

  test("recurring cron: lastFiredAt updates and prevents the same minute from re-firing", async () => {
    await withRunner(async (fired) => {
      const job = await CronStore.add({
        id: "every-min-recurring",
        schedule: "* * * * *",
        prompt: "tick",
        durable: true,
        metadata: {},
      })
      // Backdate createdAt by reusing markFired with a value 2 minutes ago.
      // After this, baseline = 2-min-ago, nextFire = within last minute → due.
      await CronStore.markFired(job.id, Date.now() - 2 * 60_000)
      await CronRunner._tickForTests()
      expect(fired).toContain("every-min-recurring")
      // Now lastFiredAt is fresh; next tick should NOT fire again immediately
      // because the next minute boundary is in the future.
      await CronRunner._tickForTests()
      expect(fired.filter((id) => id === "every-min-recurring")).toHaveLength(1)
    })
  })
})
