import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace WorkflowEvents {
  export const Started = BusEvent.define(
    "workflow.started",
    z.object({ runId: z.string(), sessionID: z.string(), name: z.string() }),
  )

  export const Progress = BusEvent.define(
    "workflow.progress",
    z.object({
      runId: z.string(),
      kind: z.enum(["phase", "log", "agent"]),
      title: z.string().optional(),
      message: z.string().optional(),
      seq: z.number().optional(),
      label: z.string().optional(),
      phase: z.string().optional(),
      status: z.enum(["started", "done", "failed"]).optional(),
      tokens: z.number().optional(),
    }),
  )

  export const Completed = BusEvent.define(
    "workflow.completed",
    z.object({ runId: z.string(), status: z.enum(["done", "failed", "stopped"]), tokens: z.number() }),
  )
}
