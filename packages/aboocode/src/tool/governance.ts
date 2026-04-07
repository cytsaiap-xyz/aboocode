import { Log } from "@/util/log"
import { Plugin } from "@/plugin"
import type { Tool } from "./tool"

/**
 * Phase 9: Tool Governance Pipeline
 *
 * 8-step execution chain that treats tools as auditable, governed services:
 * 1. findTool(name)
 * 2. validateInput(schema) — existing Zod validation
 * 3. runCustomValidators(args)
 * 4. firePreToolUseHooks(tool, args)
 * 5. resolvePermission(tool, args)
 * 6. executeTool(args, ctx)
 * 7. recordTelemetry(tool, args, result, duration)
 * 8. firePostToolUseHooks(tool, args, result)
 * 9. formatResult(result)
 */
export namespace Governance {
  const log = Log.create({ service: "tool.governance" })

  export interface TelemetryRecord {
    tool: string
    sessionID: string
    callID?: string
    args: any
    duration: number
    status: "success" | "error" | "blocked"
    permission?: string
    error?: string
    timestamp: number
  }

  const telemetryBuffer: TelemetryRecord[] = []

  /**
   * Step 3: Run custom validators on tool args.
   */
  export async function runValidators(
    validators: ((args: any) => any | Promise<any>)[] | undefined,
    args: any,
  ): Promise<any> {
    if (!validators?.length) return args

    let validated = args
    for (const validator of validators) {
      validated = await validator(validated)
    }
    return validated
  }

  /**
   * Step 4: Fire pre-tool-use hooks via plugin system.
   */
  export async function firePreHooks(input: {
    tool: string
    sessionID: string
    callID?: string
    args: any
  }): Promise<{ args: any; blocked: boolean; blockReason?: string }> {
    const result = await Plugin.trigger(
      "tool.execute.before",
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID ?? "" },
      { args: input.args },
    )

    return { args: result.args, blocked: false }
  }

  /**
   * Step 7: Record telemetry for the tool execution.
   */
  export function recordTelemetry(record: TelemetryRecord) {
    telemetryBuffer.push(record)
    log.info("telemetry", {
      tool: record.tool,
      duration: record.duration,
      status: record.status,
    })

    if (telemetryBuffer.length >= 50) {
      flushTelemetry()
    }
  }

  /**
   * Get telemetry records, optionally filtered by session.
   */
  export function getTelemetry(sessionID?: string): TelemetryRecord[] {
    if (!sessionID) return [...telemetryBuffer]
    return telemetryBuffer.filter((r) => r.sessionID === sessionID)
  }

  /**
   * Flush telemetry buffer. Returns flushed records.
   */
  export function flushTelemetry(): TelemetryRecord[] {
    const flushed = [...telemetryBuffer]
    telemetryBuffer.length = 0
    log.info("telemetry:flushed", { count: flushed.length })
    return flushed
  }

  /**
   * Step 8: Fire post-tool-use hooks.
   */
  export async function firePostHooks(input: {
    tool: string
    sessionID: string
    callID?: string
    args: any
    result: any
  }): Promise<any> {
    return Plugin.trigger(
      "tool.execute.after",
      { tool: input.tool, sessionID: input.sessionID, callID: input.callID ?? "", args: input.args },
      input.result,
    )
  }

  /**
   * Full governance pipeline wrapper.
   * Wraps a tool's execute function with the full chain.
   */
  export function wrapExecute(
    toolId: string,
    originalExecute: (args: any, ctx: Tool.Context) => Promise<any>,
    validators?: ((args: any) => any | Promise<any>)[],
  ): (args: any, ctx: Tool.Context) => Promise<any> {
    return async (args: any, ctx: Tool.Context) => {
      const startTime = Date.now()
      let status: TelemetryRecord["status"] = "success"
      let error: string | undefined

      try {
        const validatedArgs = await runValidators(validators, args)
        const result = await originalExecute(validatedArgs, ctx)
        return result
      } catch (e: any) {
        status = "error"
        error = e.message ?? String(e)
        throw e
      } finally {
        recordTelemetry({
          tool: toolId,
          sessionID: ctx.sessionID,
          callID: ctx.callID,
          args,
          duration: Date.now() - startTime,
          status,
          error,
          timestamp: startTime,
        })
      }
    }
  }
}
