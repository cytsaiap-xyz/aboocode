/**
 * Durable cron job store.
 *
 * Phase 12: persist cron-scheduled tasks to disk so they survive process
 * restarts. Layout mirrors Claude Code's `.claude/scheduled_tasks.json`
 * pattern: a single JSON file under the state dir, readable across
 * sessions.
 *
 * Each job has:
 *   - id:            stable identifier (nanoid-ish)
 *   - schedule:      5-field cron expression or one-shot ISO timestamp
 *   - prompt:        the text injected as a user message when the job fires
 *   - sessionID:     optional — scope the job to a specific session
 *   - durable:       if false, the job is dropped when this process exits
 *   - metadata:      arbitrary caller-supplied data
 *
 * The store does NOT execute jobs — that's the Scheduler's job. It just
 * records them, persists to disk, and exposes list/add/remove helpers.
 */

import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "scheduler.cron-store" })

const STORE_FILE = path.join(Global.Path.state, "cron-jobs.json")

export const CronJob = z.object({
  id: z.string(),
  schedule: z.string().describe("5-field cron expression, or ISO8601 timestamp for one-shot"),
  prompt: z.string(),
  sessionID: z.string().optional(),
  durable: z.boolean().default(true),
  createdAt: z.number(),
  lastFiredAt: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type CronJob = z.infer<typeof CronJob>

const Store = z.object({
  version: z.literal(1).default(1),
  jobs: z.array(CronJob).default([]),
})
type Store = z.infer<typeof Store>

let cache: Store | null = null

export namespace CronStore {
  async function load(): Promise<Store> {
    if (cache) return cache
    try {
      const raw = await fs.readFile(STORE_FILE, "utf-8")
      const parsed = Store.parse(JSON.parse(raw))
      cache = parsed
      return parsed
    } catch {
      const empty: Store = { version: 1, jobs: [] }
      cache = empty
      return empty
    }
  }

  async function save(store: Store): Promise<void> {
    cache = store
    await fs.mkdir(path.dirname(STORE_FILE), { recursive: true })
    // Atomic write: write to temp then rename, so a crash mid-save
    // doesn't corrupt the store.
    const tmp = STORE_FILE + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8")
    await fs.rename(tmp, STORE_FILE)
  }

  export async function list(filter?: { sessionID?: string; durableOnly?: boolean }): Promise<CronJob[]> {
    const store = await load()
    let jobs = store.jobs
    if (filter?.sessionID) jobs = jobs.filter((j) => j.sessionID === filter.sessionID)
    if (filter?.durableOnly) jobs = jobs.filter((j) => j.durable)
    return jobs
  }

  export async function add(job: Omit<CronJob, "createdAt">): Promise<CronJob> {
    const store = await load()
    if (store.jobs.some((j) => j.id === job.id)) {
      throw new Error(`Cron job with id "${job.id}" already exists`)
    }
    const full: CronJob = { ...job, createdAt: Date.now() }
    store.jobs.push(full)
    await save(store)
    log.info("cron added", { id: full.id, schedule: full.schedule, durable: full.durable })
    return full
  }

  export async function remove(id: string): Promise<boolean> {
    const store = await load()
    const before = store.jobs.length
    store.jobs = store.jobs.filter((j) => j.id !== id)
    if (store.jobs.length === before) return false
    await save(store)
    log.info("cron removed", { id })
    return true
  }

  export async function get(id: string): Promise<CronJob | undefined> {
    const store = await load()
    return store.jobs.find((j) => j.id === id)
  }

  export async function markFired(id: string, firedAt: number): Promise<void> {
    const store = await load()
    const job = store.jobs.find((j) => j.id === id)
    if (!job) return
    job.lastFiredAt = firedAt
    await save(store)
  }

  /** Test helper — wipes the in-memory cache and file. */
  export async function _resetForTests(): Promise<void> {
    cache = null
    try {
      await fs.unlink(STORE_FILE)
    } catch {
      /* ok if not present */
    }
  }
}
