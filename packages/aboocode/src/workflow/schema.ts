import type { MessageV2 } from "../session/message-v2"

export namespace WorkflowSchema {
  export function toFormat(schema: Record<string, any>): MessageV2.OutputFormat {
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
}
