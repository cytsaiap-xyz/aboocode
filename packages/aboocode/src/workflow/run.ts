import { Bus } from "../bus"
import { WorkflowRuntime } from "./runtime"
import { WorkflowEngine } from "./engine"
import { WorkflowJournal } from "./journal"
import { WorkflowBudget } from "./budget"
import { WorkflowConcurrency } from "./concurrency"
import { WorkflowSpawn } from "./spawn"
import { WorkflowEvents } from "./events"
import type { WorkflowTypes } from "./types"

export namespace WorkflowRun {
  const MAX_AGENTS = 1000

  export interface ExecuteInput {
    sessionID: string
    source: string
    scriptPath: string
    args: unknown
    model?: { providerID: string; modelID: string }
    budgetTotal?: number | null
    resumeFromRunId?: string
    spawn?: WorkflowTypes.SpawnFn
    abort?: AbortSignal
  }

  export interface ExecuteResult {
    runId: string
    status: WorkflowJournal.Status
    value?: any
    error?: string
  }

  async function drive(runId: string, name: string, input: ExecuteInput): Promise<ExecuteResult> {
    Bus.publish(WorkflowEvents.Started, { runId, sessionID: input.sessionID, name })

    let seq = 0
    let spawned = 0
    const spawnFn = input.spawn ?? ((p, o, c) => WorkflowSpawn.run(p, o, c))

    const ctx: WorkflowTypes.RunContext = {
      runId,
      sessionID: input.sessionID,
      model: input.model,
      args: input.args,
      resume: Boolean(input.resumeFromRunId),
      depth: 0,
      abort: input.abort ?? new AbortController().signal,
      budget: WorkflowBudget.create(input.budgetTotal ?? null),
      semaphore: WorkflowConcurrency.create(),
      nextSeq: () => seq++,
      guardSpawn: () => {
        spawned++
        if (spawned > MAX_AGENTS) throw new Error(`workflow exceeded ${MAX_AGENTS} agents`)
      },
      journal: WorkflowJournal.bind(runId),
      spawn: spawnFn,
      emit: (ev) =>
        Bus.publish(WorkflowEvents.Progress, {
          runId,
          kind: ev.kind,
          title: "title" in ev ? ev.title : undefined,
          message: "message" in ev ? ev.message : undefined,
          seq: "seq" in ev ? ev.seq : undefined,
          label: "label" in ev ? ev.label : undefined,
          phase: "phase" in ev ? ev.phase : undefined,
          status: "status" in ev ? ev.status : undefined,
          tokens: "tokens" in ev ? ev.tokens : undefined,
        }),
    }

    const globals = WorkflowEngine.build(ctx)
    try {
      const value = await WorkflowRuntime.evaluate(input.source, globals as any)
      WorkflowJournal.setStatus(runId, "done")
      const run = await WorkflowJournal.getRun(runId)
      Bus.publish(WorkflowEvents.Completed, { runId, status: "done", tokens: run?.tokens_total ?? 0 })
      return { runId, status: "done", value }
    } catch (e) {
      const error = (e as Error).message
      WorkflowJournal.setStatus(runId, "failed")
      const run = await WorkflowJournal.getRun(runId)
      Bus.publish(WorkflowEvents.Completed, { runId, status: "failed", tokens: run?.tokens_total ?? 0 })
      return { runId, status: "failed", error }
    }
  }

  export async function start(
    input: ExecuteInput,
    meta?: WorkflowRuntime.Meta,
  ): Promise<{ runId: string; done: Promise<ExecuteResult> }> {
    const m = meta ?? WorkflowRuntime.parseMeta(input.source)

    const runId =
      input.resumeFromRunId ??
      (await WorkflowJournal.createRun({
        sessionID: input.sessionID,
        name: m.name,
        scriptPath: input.scriptPath,
        model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
        args: input.args,
      }))

    if (input.resumeFromRunId) WorkflowJournal.setStatus(runId, "running")

    const done = drive(runId, m.name, input)
    return { runId, done }
  }

  export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
    const { done } = await start(input)
    return done
  }
}
