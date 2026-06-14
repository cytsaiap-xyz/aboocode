import { randomBytes, createHash } from "crypto"
import { eq, and, gte } from "drizzle-orm"
import { Database } from "@/storage/db"
import { WorkflowRunTable, WorkflowAgentCallTable } from "./workflow.sql"
import type { WorkflowTypes } from "./types"

export namespace WorkflowJournal {
  export type Status = "running" | "paused" | "done" | "failed" | "stopped"

  function id(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`
  }

  function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((value as any)[k])).join(",") + "}"
  }

  export function callKey(seq: number, prompt: string, opts: WorkflowTypes.AgentOpts): string {
    return createHash("sha256").update(`${seq} ${prompt} ${canonical(opts)}`).digest("hex")
  }

  export async function createRun(input: {
    sessionID: string
    name: string
    scriptPath: string
    model?: string
    args: unknown
  }): Promise<string> {
    const runId = id("wfr")
    Database.use((db) =>
      db
        .insert(WorkflowRunTable)
        .values({
          id: runId,
          session_id: input.sessionID,
          name: input.name,
          script_path: input.scriptPath,
          status: "running",
          args_json: input.args === undefined ? null : JSON.stringify(input.args),
          model: input.model ?? null,
        })
        .run(),
    )
    return runId
  }

  export function setStatus(runId: string, status: Status): void {
    Database.use((db) => db.update(WorkflowRunTable).set({ status }).where(eq(WorkflowRunTable.id, runId)).run())
  }

  export async function getRun(runId: string) {
    return Database.use((db) => db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runId)).all()[0])
  }

  export function bind(runId: string): WorkflowTypes.JournalBinding {
    return {
      async lookup(seq) {
        const row = Database.use((db) =>
          db
            .select()
            .from(WorkflowAgentCallTable)
            .where(and(eq(WorkflowAgentCallTable.run_id, runId), eq(WorkflowAgentCallTable.seq, seq)))
            .all()[0],
        )
        if (!row) return undefined
        return { callKey: row.call_key, result: row.result_json === null ? null : JSON.parse(row.result_json) }
      },
      async record(entry) {
        Database.transaction((db) => {
          db.insert(WorkflowAgentCallTable)
            .values({
              id: id("wfc"),
              run_id: runId,
              seq: entry.seq,
              call_key: entry.callKey,
              label: entry.label ?? null,
              phase: entry.phase ?? null,
              prompt: entry.prompt,
              opts_json: JSON.stringify(entry.opts),
              result_json: entry.result === undefined ? null : JSON.stringify(entry.result),
              status: entry.status,
              tokens: entry.tokens,
              time_started: Date.now(),
              time_ended: Date.now(),
            })
            .run()
          const run = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runId)).all()[0]
          db.update(WorkflowRunTable)
            .set({ tokens_total: (run?.tokens_total ?? 0) + entry.tokens })
            .where(eq(WorkflowRunTable.id, runId))
            .run()
        })
      },
      async invalidateFrom(seq) {
        Database.use((db) =>
          db
            .delete(WorkflowAgentCallTable)
            .where(and(eq(WorkflowAgentCallTable.run_id, runId), gte(WorkflowAgentCallTable.seq, seq)))
            .run(),
        )
      },
    }
  }
}
