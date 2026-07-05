import path from "path"
import { Bus } from "../bus"
import { WorkflowRuntime } from "./runtime"
import { WorkflowEngine } from "./engine"
import { WorkflowJournal } from "./journal"
import { WorkflowBudget } from "./budget"
import { WorkflowConcurrency } from "./concurrency"
import { WorkflowSpawn } from "./spawn"
import { WorkflowEvents } from "./events"
import { Instance } from "../project/instance"
import type { WorkflowTypes } from "./types"

export namespace WorkflowRun {
  const MAX_AGENTS = 1000
  const liveRuns = new Set<string>()

  export async function resolveRef(
    ref: string | { scriptPath: string },
  ): Promise<{ source: string; scriptPath: string }> {
    const scriptPath =
      typeof ref === "string" ? path.join(Instance.directory, ".aboocode", "workflows", `${ref}.js`) : ref.scriptPath
    const file = Bun.file(scriptPath)
    if (!(await file.exists())) throw new Error(`workflow not found: ${typeof ref === "string" ? ref : scriptPath}`)
    return { source: await file.text(), scriptPath }
  }

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
    liveRuns.add(runId)
    Bus.publish(WorkflowEvents.Started, { runId, sessionID: input.sessionID, name })

    let seq = 0
    let spawned = 0
    const spawnFn = input.spawn ?? ((p, o, c) => WorkflowSpawn.run(p, o, c))
    const priorTokens = input.resumeFromRunId ? ((await WorkflowJournal.getRun(runId))?.tokens_total ?? 0) : 0

    const ctx: WorkflowTypes.RunContext = {
      runId,
      sessionID: input.sessionID,
      model: input.model,
      args: input.args,
      resume: Boolean(input.resumeFromRunId),
      depth: 0,
      abort: input.abort ?? new AbortController().signal,
      budget: WorkflowBudget.create(input.budgetTotal ?? null, priorTokens),
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
      child: async (ref, childArgs) => {
        if (ctx.depth >= 1) throw new Error("workflow() nesting is limited to one level")
        const resolved = await resolveRef(ref)
        const childMeta = WorkflowRuntime.parseMeta(resolved.source)
        const childRunId = await WorkflowJournal.createRun({
          sessionID: input.sessionID,
          name: childMeta.name,
          scriptPath: resolved.scriptPath,
          model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
          args: childArgs,
        })
        let childSeq = 0
        const childCtx: WorkflowTypes.RunContext = {
          ...ctx,
          runId: childRunId,
          args: childArgs,
          resume: false,
          depth: ctx.depth + 1,
          nextSeq: () => childSeq++,
          journal: WorkflowJournal.bind(childRunId),
          child: () => Promise.reject(new Error("workflow() nesting is limited to one level")),
        }
        try {
          const value = await WorkflowRuntime.evaluate(resolved.source, WorkflowEngine.build(childCtx) as any)
          await WorkflowJournal.setStatus(childRunId, "done")
          return value
        } catch (e) {
          await WorkflowJournal.setStatus(childRunId, ctx.abort.aborted ? "stopped" : "failed")
          throw e
        }
      },
    }

    const globals = WorkflowEngine.build(ctx)
    try {
      const value = await WorkflowRuntime.evaluate(input.source, globals as any)
      await WorkflowJournal.setStatus(runId, "done")
      const run = await WorkflowJournal.getRun(runId)
      Bus.publish(WorkflowEvents.Completed, { runId, status: "done", tokens: run?.tokens_total ?? 0 })
      liveRuns.delete(runId)
      return { runId, status: "done", value }
    } catch (e) {
      const error = (e as Error).message
      const status: WorkflowJournal.Status = ctx.abort.aborted ? "stopped" : "failed"
      await WorkflowJournal.setStatus(runId, status)
      const run = await WorkflowJournal.getRun(runId)
      Bus.publish(WorkflowEvents.Completed, { runId, status, tokens: run?.tokens_total ?? 0 })
      liveRuns.delete(runId)
      return { runId, status, error }
    }
  }

  export async function start(
    input: ExecuteInput,
    meta?: WorkflowRuntime.Meta,
  ): Promise<{ runId: string; done: Promise<ExecuteResult> }> {
    const m = meta ?? WorkflowRuntime.parseMeta(input.source)

    if (input.resumeFromRunId) {
      const existing = await WorkflowJournal.getRun(input.resumeFromRunId)
      if (!existing) throw new Error(`workflow run not found: ${input.resumeFromRunId}`)
      if (existing.status === "running") {
        if (liveRuns.has(input.resumeFromRunId))
          throw new Error(`workflow run ${input.resumeFromRunId} is still running; stop it before resuming`)
        // Stale "running" row from a crashed process — reset so resume can proceed.
        await WorkflowJournal.setStatus(input.resumeFromRunId, "failed")
      }
    }

    const runId =
      input.resumeFromRunId ??
      (await WorkflowJournal.createRun({
        sessionID: input.sessionID,
        name: m.name,
        scriptPath: input.scriptPath,
        model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
        args: input.args,
      }))

    if (input.resumeFromRunId) await WorkflowJournal.setStatus(runId, "running")

    const done = drive(runId, m.name, input)
    return { runId, done }
  }

  export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
    const { done } = await start(input)
    return done
  }
}
