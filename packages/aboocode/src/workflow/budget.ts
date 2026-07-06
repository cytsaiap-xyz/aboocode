import type { WorkflowTypes } from "./types"

export namespace WorkflowBudget {
  export function create(total: number | null, initialUsed = 0): WorkflowTypes.Budget {
    let used = Math.max(0, initialUsed)
    return {
      total,
      spent: () => used,
      remaining: () => (total === null ? Infinity : Math.max(0, total - used)),
      add: (tokens: number) => {
        used += Math.max(0, tokens)
      },
      sub: (tokens: number) => {
        used = Math.max(0, used - tokens)
      },
    }
  }
}
