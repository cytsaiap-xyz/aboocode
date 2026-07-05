/**
 * Doom-loop detection over a sliding window of tool calls. Detection runs at
 * tool-call time for the call being made right now, i.e. the last element of
 * `calls`. Consecutive-only checks miss alternating loops (read A, run B,
 * read A, ...), so the check is: has the current call's key already appeared
 * THRESHOLD times within the last WINDOW calls? Earlier loops (e.g. a run of
 * A that preceded the current call) already fired on their own third
 * occurrence and are not re-reported here.
 */
export namespace LoopDetect {
  export const WINDOW = 8
  export const THRESHOLD = 3

  export function repeated(calls: { tool: string; input: unknown }[]): { tool: string; input: unknown } | undefined {
    const recent = calls.slice(-WINDOW)
    const current = recent[recent.length - 1]
    if (!current) return undefined
    const currentKey = `${current.tool}:${JSON.stringify(current.input)}`
    const count = recent.filter((call) => `${call.tool}:${JSON.stringify(call.input)}` === currentKey).length
    return count >= THRESHOLD ? current : undefined
  }
}
