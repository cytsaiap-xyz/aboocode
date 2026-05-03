import z from "zod"
import { Tool } from "./tool"
import { CronStore } from "@/scheduler/cron-store"
import DESCRIPTION from "./cron-delete.txt"

export const CronDeleteTool = Tool.define("cron_delete", {
  description: DESCRIPTION,
  parameters: z.object({
    id: z.string().describe("Cron job id returned by cron_create or cron_list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "cron",
      patterns: [params.id],
      always: ["*"],
      metadata: { action: "delete", id: params.id },
    })
    const removed = await CronStore.remove(params.id)
    return {
      title: removed ? `Deleted cron ${params.id}` : `Cron ${params.id} not found`,
      output: removed ? `Removed cron job ${params.id}` : `No cron job with id ${params.id}`,
      metadata: { id: params.id, removed },
    }
  },
})
