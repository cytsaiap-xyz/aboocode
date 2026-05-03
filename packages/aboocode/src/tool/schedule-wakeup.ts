import z from "zod"
import { randomBytes } from "crypto"
import { Tool } from "./tool"
import { CronStore } from "@/scheduler/cron-store"
import DESCRIPTION from "./schedule-wakeup.txt"

function wakeupId(): string {
  return `wake_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`
}

const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60

export const ScheduleWakeupTool = Tool.define("schedule_wakeup", {
  description: DESCRIPTION,
  parameters: z.object({
    delaySeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_DELAY_SECONDS)
      .describe(`Seconds from now to fire. Max ${MAX_DELAY_SECONDS} (30 days)`),
    prompt: z.string().describe("Prompt surfaced when the wakeup fires"),
    reason: z.string().optional().describe("Short reason shown in telemetry/UI"),
  }),
  async execute(params, ctx) {
    const when = Date.now() + params.delaySeconds * 1000
    const iso = new Date(when).toISOString()
    await ctx.ask({
      permission: "cron",
      patterns: [iso],
      always: ["*"],
      metadata: { schedule: iso, reason: params.reason },
    })
    const id = wakeupId()
    await CronStore.add({
      id,
      schedule: iso,
      prompt: params.prompt,
      sessionID: ctx.sessionID,
      durable: true,
      metadata: { kind: "wakeup", reason: params.reason },
    })
    return {
      title: `Wakeup scheduled ${iso}`,
      output: `Scheduled wakeup ${id} at ${iso} (in ${params.delaySeconds}s)`,
      metadata: { id, fireAt: when, delaySeconds: params.delaySeconds },
    }
  },
})
