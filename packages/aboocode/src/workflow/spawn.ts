import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Provider } from "../provider/provider"
import { WorkflowSchema } from "./schema"
import type { WorkflowTypes } from "./types"
import { Log } from "../util/log"

const log = Log.create({ service: "workflow.spawn" })

// Headless posture for workflow children: the user approved the `workflow`
// permission for the whole run at the tool boundary, so children must not
// block on interactive prompts. Mutating tools are pre-approved; todo tools
// and recursive spawning are denied (mirrors the task tool's child rules).
const CHILD_PERMISSIONS = [
  ...["edit", "write", "bash", "webfetch"].map((p) => ({ permission: p, pattern: "*", action: "allow" as const })),
  ...["todowrite", "todoread", "task", "workflow"].map((p) => ({ permission: p, pattern: "*", action: "deny" as const })),
]

export namespace WorkflowSpawn {
  export interface Deps {
    createSession: (input: { parentID: string; title: string; permission: typeof CHILD_PERMISSIONS }) => Promise<{ id: string }>
    prompt: (input: any) => Promise<{ info: any; parts: any[] }>
    parseModel: (m: string) => { providerID: string; modelID: string }
    cancel?: (sessionID: string) => void
  }

  const defaults: Deps = {
    createSession: (input) => Session.create(input as any) as any,
    prompt: (input) => SessionPrompt.prompt(input),
    parseModel: (m) => Provider.parseModel(m),
    cancel: (sessionID) => SessionPrompt.cancel(sessionID),
  }

  export async function run(
    prompt: string,
    opts: WorkflowTypes.AgentOpts,
    ctx: Pick<WorkflowTypes.RunContext, "sessionID" | "model" | "abort">,
    deps: Deps = defaults,
  ): Promise<WorkflowTypes.SpawnResult | null> {
    try {
      const child = await deps.createSession({
        parentID: ctx.sessionID,
        title: opts.label ?? "workflow agent",
        permission: CHILD_PERMISSIONS,
      })
      const model = opts.model ? deps.parseModel(opts.model) : ctx.model
      const cancel = deps.cancel ?? defaults.cancel!
      const onAbort = () => cancel(child.id)
      ctx.abort?.addEventListener("abort", onAbort, { once: true })
      let result: { info: any; parts: any[] }
      try {
        result = await deps.prompt({
          sessionID: child.id,
          agent: opts.agentType ?? "general",
          model,
          parts: [{ type: "text", text: prompt }],
          ...(opts.schema ? { format: WorkflowSchema.toFormat(opts.schema) } : {}),
        })
      } finally {
        ctx.abort?.removeEventListener("abort", onAbort)
      }
      // When a json_schema output format is used, SessionPrompt.prompt stores the parsed
      // structured result in result.info.structured (MessageV2.Assistant.structured: z.any().optional()).
      // The text parts contain only intermediate tool-use text, not the final JSON answer.
      // So for schema-constrained agents we serialize the structured object to JSON as the text
      // so WorkflowSchema.parseResult receives valid data.
      const structured = (result.info as any)?.structured
      const text =
        opts.schema && structured !== undefined
          ? JSON.stringify(structured)
          : ((result.parts.findLast((p: any) => p.type === "text") as any)?.text ?? "")
      // Real shape: result.info is MessageV2.Assistant which has tokens: { total?, input, output, reasoning, cache }
      // Defensive accessor handles both the real shape and the test fake shape (info.tokens.output)
      const tokens = result.info?.tokens?.output ?? result.info?.tokens?.total ?? 0
      return { text, tokens }
    } catch (err) {
      log.error("spawn failed", { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }
}
