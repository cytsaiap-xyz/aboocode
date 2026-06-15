import type { WorkflowTypes } from "./types"

export namespace WorkflowBudget {
  export function create(total: number | null): WorkflowTypes.Budget {
    let used = 0
    return {
      total,
      spent: () => used,
      remaining: () => (total === null ? Infinity : Math.max(0, total - used)),
      add: (tokens: number) => {
        used += Math.max(0, tokens)
      },
    }
  }
}
