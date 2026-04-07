import { Token } from "@/util/token"
import { Log } from "@/util/log"
import type { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { ProviderTransform } from "@/provider/transform"

export namespace TokenBudget {
  const log = Log.create({ service: "session.token-budget" })

  export interface State {
    /** Maximum input tokens for the model */
    maxInputTokens: number
    /** Maximum output tokens for the model */
    maxOutputTokens: number
    /** Current estimated token usage */
    currentEstimate: number
    /** Threshold at which proactive compaction should trigger (fraction of maxInputTokens) */
    compactThreshold: number
    /** Threshold at which reactive (emergency) compaction should trigger */
    reactiveThreshold: number
  }

  /**
   * Build a budget state from the model's limits.
   */
  export async function fromModel(model: Provider.Model): Promise<State> {
    const config = await Config.get()
    const maxOutput = ProviderTransform.maxOutputTokens(model)
    const rawMaxInput = model.limit.input
      ? model.limit.input
      : model.limit.context - maxOutput
    // Guard against zero/negative maxInput when model limits are not configured.
    // A 0 or negative value would make compaction trigger on every turn.
    const maxInput = rawMaxInput > 0 ? rawMaxInput : 0

    const compactFraction = config.compaction?.proactiveThreshold ?? 0.8
    const reactiveFraction = config.compaction?.reactiveThreshold ?? 0.95

    return {
      maxInputTokens: maxInput,
      maxOutputTokens: maxOutput,
      currentEstimate: 0,
      compactThreshold: Math.floor(maxInput * compactFraction),
      reactiveThreshold: Math.floor(maxInput * reactiveFraction),
    }
  }

  /**
   * Estimate token count from an array of model messages.
   */
  export function estimate(messages: { role: string; content: any }[]): number {
    let total = 0
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        total += Token.estimate(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "string") {
            total += Token.estimate(part)
          } else if (part?.text) {
            total += Token.estimate(part.text)
          } else if (part?.content) {
            total += Token.estimate(typeof part.content === "string" ? part.content : JSON.stringify(part.content))
          }
        }
      }
    }
    return total
  }

  /**
   * Check if proactive compaction should trigger.
   */
  export function shouldCompact(state: State): boolean {
    if (state.maxInputTokens <= 0) return false
    return state.currentEstimate >= state.compactThreshold
  }

  /**
   * Check if reactive (emergency) compaction should trigger.
   */
  export function shouldReactiveCompact(state: State): boolean {
    if (state.maxInputTokens <= 0) return false
    return state.currentEstimate >= state.reactiveThreshold
  }

  /**
   * Trim a tool result string to fit within a character budget.
   * Returns the original string if it fits, otherwise truncates with a marker.
   */
  export function trimToolResult(result: string, charBudget: number): string {
    if (result.length <= charBudget) return result
    if (charBudget <= 100) return result.slice(0, charBudget)

    const keepStart = Math.floor(charBudget * 0.7)
    const keepEnd = Math.floor(charBudget * 0.2)
    const omitted = result.length - keepStart - keepEnd

    return [
      result.slice(0, keepStart),
      `\n\n[... ${omitted} characters omitted for context budget ...]\n\n`,
      result.slice(result.length - keepEnd),
    ].join("")
  }

  /**
   * Log budget status for debugging.
   */
  export function logStatus(state: State): void {
    const pct = state.maxInputTokens > 0 ? Math.round((state.currentEstimate / state.maxInputTokens) * 100) : 0
    log.info("token budget", {
      estimate: state.currentEstimate,
      max: state.maxInputTokens,
      pct: `${pct}%`,
      shouldCompact: shouldCompact(state),
      shouldReactive: shouldReactiveCompact(state),
    })
  }
}
