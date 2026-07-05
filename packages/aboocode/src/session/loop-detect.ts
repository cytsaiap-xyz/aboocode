/**
 * Doom-loop detection over a sliding window of tool calls. Consecutive-only
 * checks miss alternating loops (read A, run B, read A, ...), so any call
 * repeated THRESHOLD times within the last WINDOW calls counts as a loop.
 */
export namespace LoopDetect {
  export const WINDOW = 8
  export const THRESHOLD = 3

  export function repeated(calls: { tool: string; input: unknown }[]): { tool: string; input: unknown } | undefined {
    const recent = calls.slice(-WINDOW)
    const counts = new Map<string, { call: { tool: string; input: unknown }; count: number }>()
    for (const call of recent) {
      const key = `${call.tool}:${JSON.stringify(call.input)}`
      const entry = counts.get(key) ?? { call, count: 0 }
      entry.count++
      counts.set(key, entry)
      if (entry.count >= THRESHOLD) return entry.call
    }
    return undefined
  }
}
