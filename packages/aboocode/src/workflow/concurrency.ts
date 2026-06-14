import os from "os"

export namespace WorkflowConcurrency {
  export class Semaphore {
    readonly limit: number
    private active = 0
    private queue: (() => void)[] = []

    constructor(limit: number) {
      this.limit = Math.max(1, limit)
    }

    acquire(): Promise<void> {
      if (this.active < this.limit) {
        this.active++
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => this.queue.push(resolve))
    }

    release(): void {
      const next = this.queue.shift()
      if (next) {
        next()
        return
      }
      this.active = Math.max(0, this.active - 1)
    }
  }

  export function create(): Semaphore {
    const cores = os.cpus().length || 1
    return new Semaphore(Math.min(16, Math.max(1, cores - 2)))
  }
}
