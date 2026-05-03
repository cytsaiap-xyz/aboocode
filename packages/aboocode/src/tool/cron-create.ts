import z from "zod"
import { randomBytes } from "crypto"
import { Tool } from "./tool"
import { CronStore } from "@/scheduler/cron-store"
import { Cron } from "@/scheduler/cron"
import DESCRIPTION from "./cron-create.txt"

function cronId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`
}

export const CronCreateTool = Tool.define("cron_create", {
  description: DESCRIPTION,
  parameters: z.object({
    schedule: z
      .string()
      .describe('Cron expression ("*/15 * * * *"), interval ("@every 30m"), or ISO timestamp for one-shot'),
    prompt: z.string().describe("Prompt to surface when the job fires"),
    durable: z.boolean().default(true).describe("If true, the job persists across process restarts (default true)"),
    metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary caller metadata"),
  }),
  async execute(params, ctx) {
    Cron.validate(params.schedule)
    await ctx.ask({
      permission: "cron",
      patterns: [params.schedule],
      always: ["*"],
      metadata: { schedule: params.schedule, durable: params.durable },
    })
    const id = cronId("cron")
    const job = await CronStore.add({
      id,
      schedule: params.schedule,
      prompt: params.prompt,
      sessionID: ctx.sessionID,
      durable: params.durable,
      metadata: params.metadata ?? {},
    })
    const next = Cron.nextFire(params.schedule)
    const nextLabel = Number.isFinite(next) ? new Date(next).toISOString() : "never (one-shot in the past)"
    return {
      title: `Scheduled cron ${id}`,
      output: `Created cron job ${id}\n  schedule: ${params.schedule}\n  durable:  ${job.durable}\n  next:     ${nextLabel}`,
      metadata: { id, schedule: params.schedule, durable: job.durable, nextFireAt: Number.isFinite(next) ? next : null },
    }
  },
})
