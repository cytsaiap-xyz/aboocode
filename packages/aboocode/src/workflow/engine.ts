import type { WorkflowTypes } from "./types"
import { WorkflowSchema } from "./schema"
import { WorkflowJournal } from "./journal"

export namespace WorkflowEngine {
  const MAX_ITEMS = 4096

  export function build(ctx: WorkflowTypes.RunContext) {
    let currentPhase: string | undefined

    async function agent(prompt: string, rawOpts: WorkflowTypes.AgentOpts = {}): Promise<any> {
      const opts = WorkflowSchema.validateOpts(rawOpts)
      if (ctx.abort.aborted) throw new Error("workflow aborted")
      const seq = ctx.nextSeq()
      const phase = opts.phase ?? currentPhase
      const callKey = WorkflowJournal.callKey(seq, prompt, opts)

      if (ctx.resume) {
        const cached = await ctx.journal.lookup(seq)
        if (cached && cached.callKey === callKey) return cached.result
        if (cached) await ctx.journal.invalidateFrom(seq)
      }

      // Soft cap under concurrency: concurrent agent() calls each pass this check before
      // any spend is recorded, so the workflow can overshoot by up to
      // (semaphore.limit - 1) * tokens_per_call. The purpose of this guard is to stop
      // *issuing new* calls once already overspent, not to hard-reserve tokens.
      if (ctx.budget.total !== null && ctx.budget.remaining() <= 0)
        throw new Error("workflow budget exceeded")
      ctx.guardSpawn()

      await ctx.semaphore.acquire()
      if (ctx.abort.aborted) {
        ctx.semaphore.release()
        throw new Error("workflow aborted")
      }
      ctx.emit({ kind: "agent", runId: ctx.runId, seq, label: opts.label, phase, status: "started" })
      try {
        const res = await ctx.spawn(prompt, opts, ctx)
        if (!res) {
          await ctx.journal.record({ seq, callKey, label: opts.label, phase, prompt, opts, result: null, tokens: 0, status: "failed" })
          ctx.emit({ kind: "agent", runId: ctx.runId, seq, label: opts.label, phase, status: "failed" })
          return null
        }
        let value: any = res.text
        if (opts.schema) {
          try {
            value = WorkflowSchema.parseResult(res.text)
          } catch {
            ctx.budget.add(res.tokens)
            await ctx.journal.record({ seq, callKey, label: opts.label, phase, prompt, opts, result: null, tokens: res.tokens, status: "failed" })
            ctx.emit({ kind: "agent", runId: ctx.runId, seq, label: opts.label, phase, status: "failed", tokens: res.tokens })
            return null
          }
        }
        ctx.budget.add(res.tokens)
        await ctx.journal.record({ seq, callKey, label: opts.label, phase, prompt, opts, result: value, tokens: res.tokens, status: "done" })
        ctx.emit({ kind: "agent", runId: ctx.runId, seq, label: opts.label, phase, status: "done", tokens: res.tokens })
        return value
      } finally {
        ctx.semaphore.release()
      }
    }

    async function parallel(thunks: Array<() => Promise<any>>): Promise<any[]> {
      if (thunks.length > MAX_ITEMS) throw new Error(`parallel() accepts at most ${MAX_ITEMS} items`)
      return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
    }

    async function pipeline(items: any[], ...stages: Array<(prev: any, item: any, index: number) => Promise<any>>): Promise<any[]> {
      if (items.length > MAX_ITEMS) throw new Error(`pipeline() accepts at most ${MAX_ITEMS} items`)
      return Promise.all(
        items.map(async (item, index) => {
          let acc = item
          for (const stage of stages) {
            try {
              acc = await stage(acc, item, index)
            } catch {
              return null
            }
          }
          return acc
        }),
      )
    }

    function phase(title: string): void {
      currentPhase = title
      ctx.emit({ kind: "phase", runId: ctx.runId, title })
    }

    function log(message: string): void {
      ctx.emit({ kind: "log", runId: ctx.runId, message })
    }

    // workflow() composition is wired in a later task (needs the run loader); placeholder
    // that errors keeps the global present and the contract explicit until then.
    async function workflow(): Promise<any> {
      throw new Error("workflow() composition is not available yet")
    }

    return { agent, parallel, pipeline, phase, log, workflow, budget: ctx.budget, args: ctx.args }
  }
}
