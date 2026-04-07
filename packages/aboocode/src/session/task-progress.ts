import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Instance } from "../project/instance"
import { Log } from "@/util/log"

export namespace TaskProgress {
  const log = Log.create({ service: "session.task-progress" })

  export const Info = z
    .object({
      sessionID: z.string(),
      parentSessionID: z.string().optional(),
      agent: z.string(),
      toolCalls: z.number(),
      tokensUsed: z.number(),
      lastTool: z.string().optional(),
      lastActivity: z.string().optional(),
    })
    .meta({ ref: "TaskProgress" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "task.progress",
      Info,
    ),
    Started: BusEvent.define(
      "task.started",
      z.object({
        sessionID: z.string(),
        parentSessionID: z.string().optional(),
        agent: z.string(),
        description: z.string(),
      }),
    ),
    Completed: BusEvent.define(
      "task.completed",
      z.object({
        sessionID: z.string(),
        parentSessionID: z.string().optional(),
        agent: z.string(),
        summary: z.string().optional(),
      }),
    ),
    Failed: BusEvent.define(
      "task.failed",
      z.object({
        sessionID: z.string(),
        parentSessionID: z.string().optional(),
        agent: z.string(),
        error: z.string(),
      }),
    ),
  }

  // In-memory progress counters per session
  const state = Instance.state(() => {
    const progress: Record<string, Info> = {}
    return progress
  })

  /**
   * Record a tool call for a session, incrementing the counter and emitting a progress event.
   */
  export function recordToolCall(input: {
    sessionID: string
    parentSessionID?: string
    agent: string
    tool: string
    tokensUsed?: number
  }): void {
    const key = input.sessionID
    const existing = state()[key] ?? {
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      toolCalls: 0,
      tokensUsed: 0,
    }

    existing.toolCalls++
    existing.tokensUsed += input.tokensUsed ?? 0
    existing.lastTool = input.tool
    existing.lastActivity = new Date().toISOString()
    state()[key] = existing

    Bus.publish(Event.Updated, existing)
  }

  /**
   * Get current progress for a session.
   */
  export function get(sessionID: string): Info | undefined {
    return state()[sessionID]
  }

  /**
   * Emit task started event.
   */
  export function started(input: {
    sessionID: string
    parentSessionID?: string
    agent: string
    description: string
  }): void {
    Bus.publish(Event.Started, input)
    log.info("task started", { sessionID: input.sessionID, agent: input.agent })
  }

  /**
   * Emit task completed event and clean up progress state.
   */
  export function completed(input: {
    sessionID: string
    parentSessionID?: string
    agent: string
    summary?: string
  }): void {
    Bus.publish(Event.Completed, input)
    delete state()[input.sessionID]
    log.info("task completed", { sessionID: input.sessionID, agent: input.agent })
  }

  /**
   * Emit task failed event and clean up progress state.
   */
  export function failed(input: {
    sessionID: string
    parentSessionID?: string
    agent: string
    error: string
  }): void {
    Bus.publish(Event.Failed, input)
    delete state()[input.sessionID]
    log.info("task failed", { sessionID: input.sessionID, agent: input.agent })
  }
}
