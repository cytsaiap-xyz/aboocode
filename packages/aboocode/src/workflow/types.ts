export namespace WorkflowTypes {
  export interface AgentOpts {
    label?: string
    phase?: string
    schema?: Record<string, any> // JSON Schema
    model?: string // alias or full id
    isolation?: "worktree"
    agentType?: string
  }

  export interface Budget {
    total: number | null
    spent(): number
    remaining(): number
    add(tokens: number): void
  }

  export interface SpawnResult {
    text: string
    tokens: number
  }

  export type SpawnFn = (prompt: string, opts: AgentOpts, ctx: RunContext) => Promise<SpawnResult | null>

  export interface JournalEntry {
    seq: number
    callKey: string
    label?: string
    phase?: string
    prompt: string
    opts: AgentOpts
    result: any
    tokens: number
    status: "done" | "failed"
  }

  export interface JournalBinding {
    lookup(seq: number): Promise<{ callKey: string; result: any } | undefined>
    record(entry: JournalEntry): Promise<void>
    invalidateFrom(seq: number): Promise<void>
  }

  export type WorkflowEvent =
    | { kind: "phase"; runId: string; title: string }
    | { kind: "log"; runId: string; message: string }
    | { kind: "agent"; runId: string; seq: number; label?: string; phase?: string; status: "started" | "done" | "failed"; tokens?: number }

  export interface RunContext {
    runId: string
    sessionID: string
    model?: { providerID: string; modelID: string }
    args: any
    resume: boolean
    depth: number
    abort: AbortSignal
    budget: Budget
    semaphore: { acquire(): Promise<void>; release(): void }
    nextSeq(): number
    guardSpawn(): void
    journal: JournalBinding
    spawn: SpawnFn
    emit(ev: WorkflowEvent): void
    child(ref: string | { scriptPath: string }, args?: any): Promise<any>
  }
}
