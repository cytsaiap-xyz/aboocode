import z from "zod"
import { Tool } from "./tool"
import { CronStore } from "@/scheduler/cron-store"
import { Cron } from "@/scheduler/cron"
import DESCRIPTION from "./cron-list.txt"

export const CronListTool = Tool.define("cron_list", {
  description: DESCRIPTION,
  parameters: z.object({
    scope: z.enum(["session", "all"]).default("all").describe("session → only this session's jobs, all → every job"),
  }),
  async execute(params, ctx) {
    const jobs = await CronStore.list(params.scope === "session" ? { sessionID: ctx.sessionID } : undefined)
    if (jobs.length === 0) {
      return { title: "No cron jobs", output: "No cron jobs scheduled.", metadata: { count: 0, ids: [] as string[] } }
    }
    const lines = jobs.map((j) => {
      const next = Cron.nextFire(j.schedule)
      const nextLabel = Number.isFinite(next) ? new Date(next).toISOString() : "—"
      const last = j.lastFiredAt ? new Date(j.lastFiredAt).toISOString() : "never"
      const promptPreview = j.prompt.length > 60 ? j.prompt.slice(0, 57) + "..." : j.prompt
      return `${j.id}  ${j.schedule}  durable=${j.durable}  last=${last}  next=${nextLabel}\n    prompt: ${promptPreview}`
    })
    return {
      title: `${jobs.length} cron job${jobs.length === 1 ? "" : "s"}`,
      output: lines.join("\n"),
      metadata: { count: jobs.length, ids: jobs.map((j) => j.id) },
    }
  },
})
