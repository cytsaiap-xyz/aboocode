import z from "zod"
import type { MessageV2 } from "../session/message-v2"
import type { WorkflowTypes } from "./types"

export namespace WorkflowSchema {
  export function toFormat(schema: Record<string, any>): Extract<MessageV2.OutputFormat, { type: "json_schema" }> {
    return { type: "json_schema", schema, retryCount: 2 }
  }

  // The json_schema format already validates against the schema with retries, so the
  // returned text should be conforming JSON. Strip an optional ```json fence and parse.
  export function parseResult(text: string): any {
    const trimmed = text.trim()
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
    const body = fenced ? fenced[1] : trimmed
    return JSON.parse(body)
  }

  const AgentOptsSchema = z
    .object({
      label: z.string().optional(),
      phase: z.string().optional(),
      schema: z.record(z.string(), z.any()).optional(),
      model: z.string().optional(),
      isolation: z.literal("worktree").optional(),
      agentType: z.string().optional(),
    })
    .strict()

  /** Validate agent() opts coming from the sandboxed script (typed `any` there). */
  export function validateOpts(opts: unknown): WorkflowTypes.AgentOpts {
    const parsed = AgentOptsSchema.safeParse(opts ?? {})
    if (!parsed.success) throw new Error(`agent() opts invalid: ${parsed.error.issues[0]?.message ?? "bad shape"}`)
    try {
      JSON.stringify(parsed.data)
    } catch (e) {
      throw new Error(`agent() opts invalid: not JSON-serializable (${(e as Error).message})`)
    }
    return parsed.data
  }
}
