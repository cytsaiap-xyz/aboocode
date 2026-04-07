import { Log } from "@/util/log"

/**
 * Phase 5: Streaming Tool Executor
 *
 * Manages concurrent tool execution with mutex-based gating.
 * Concurrent-safe tools (read, grep, glob, etc.) run in parallel.
 * Non-concurrent tools (bash, edit, write) run exclusively.
 */
export namespace StreamingExecutor {
  const log = Log.create({ service: "session.executor" })

  export interface ExecutorState {
    active: Map<string, boolean>
    queue: Array<{ toolId: string; isConcurrencySafe: boolean; resolve: () => void }>
    exclusiveLock: boolean
  }

  export function create(): ExecutorState & {
    gate(toolId: string, isConcurrencySafe: boolean): Promise<void>
    release(toolId: string): void
    abortSiblings(errorToolId: string): string[]
  } {
    const state: ExecutorState = {
      active: new Map(),
      queue: [],
      exclusiveLock: false,
    }

    function canExecute(isConcurrencySafe: boolean): boolean {
      if (state.exclusiveLock) return false
      if (isConcurrencySafe) return true
      return state.active.size === 0
    }

    function drainQueue() {
      const next: typeof state.queue = []
      for (const waiter of state.queue) {
        if (canExecute(waiter.isConcurrencySafe)) {
          if (!waiter.isConcurrencySafe) {
            state.exclusiveLock = true
          }
          state.active.set(waiter.toolId, waiter.isConcurrencySafe)
          waiter.resolve()
        } else {
          next.push(waiter)
        }
      }
      state.queue = next
    }

    return {
      ...state,

      async gate(toolId: string, isConcurrencySafe: boolean): Promise<void> {
        if (canExecute(isConcurrencySafe)) {
          if (!isConcurrencySafe) {
            state.exclusiveLock = true
          }
          state.active.set(toolId, isConcurrencySafe)
          log.info("gate:acquired", { toolId, isConcurrencySafe, active: state.active.size })
          return
        }

        log.info("gate:queued", { toolId, isConcurrencySafe, active: state.active.size })
        return new Promise<void>((resolve) => {
          state.queue.push({ toolId, isConcurrencySafe, resolve })
        })
      },

      release(toolId: string) {
        const wasConcurrent = state.active.get(toolId)
        state.active.delete(toolId)
        if (wasConcurrent === false) {
          state.exclusiveLock = false
        }
        log.info("gate:released", { toolId, active: state.active.size })
        drainQueue()
      },

      abortSiblings(errorToolId: string): string[] {
        const aborted: string[] = []
        for (const [id] of state.active) {
          if (id !== errorToolId) {
            aborted.push(id)
          }
        }
        log.info("abort:siblings", { errorToolId, aborted })
        return aborted
      },
    }
  }
}
