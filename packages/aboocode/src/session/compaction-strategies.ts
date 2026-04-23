/**
 * Compaction strategies — reactive, snip, microcompact, end-of-turn.
 *
 * Ports the strategy-select logic from claude-code-leak's
 * src/services/compact/ + src/query/tokenBudget.ts. The existing
 * aboocode compaction.ts already implements microCompact, prune, and
 * end-of-turn summarization; this file adds the reactive mid-turn path
 * and the snip fallback, then exposes a single `selectStrategy` entry
 * point used by the session loop.
 */

import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { HookLifecycle } from "@/hook/lifecycle"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { Token } from "@/util/token"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import { SessionCompaction } from "./compaction"
import { Session } from "."

const log = Log.create({ service: "session.compaction-strategies" })

export namespace CompactionStrategies {
  export type Strategy = "none" | "microcompact" | "snip" | "reactive" | "summarize"

  export interface BudgetSnapshot {
    used: number
    limit: number
    reserved: number
    usable: number
    ratio: number
  }

  /**
   * Compute a budget snapshot for the current turn. Caller decides what to
   * do with it — selectStrategy() consumes this to pick a strategy.
   */
  export async function budget(input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }): Promise<BudgetSnapshot> {
    const config = await Config.get()
    const used =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
    const limit = input.model.limit.context
    const reserved =
      config.compaction?.reserved ?? Math.min(20_000, ProviderTransform.maxOutputTokens(input.model))
    const usable = input.model.limit.input
      ? input.model.limit.input - reserved
      : limit - ProviderTransform.maxOutputTokens(input.model)
    const ratio = limit === 0 ? 0 : used / Math.max(1, usable)
    return { used, limit, reserved, usable, ratio }
  }

  /**
   * Select the cheapest strategy that brings the turn back under budget.
   *
   * Thresholds (overridable via config.compaction.thresholds):
   *   ratio < 0.75  → none            (plenty of headroom)
   *   ratio < 0.85  → microcompact    (clear old tool results, keep recent)
   *   ratio < 0.92  → snip            (drop the oldest N tool-result pairs)
   *   ratio < 0.97  → reactive        (summarize mid-turn, keep last user)
   *   ratio ≥ 0.97  → summarize       (full end-of-turn summarization)
   */
  export async function selectStrategy(budget: BudgetSnapshot): Promise<Strategy> {
    const config = await Config.get()
    const t = (config.compaction as { thresholds?: Record<string, number> } | undefined)?.thresholds ?? {}
    const micro = t.micro ?? 0.75
    const snip = t.snip ?? 0.85
    const reactive = t.reactive ?? 0.92
    const summarize = t.summarize ?? 0.97
    if (budget.ratio < micro) return "none"
    if (budget.ratio < snip) return "microcompact"
    if (budget.ratio < reactive) return "snip"
    if (budget.ratio < summarize) return "reactive"
    return "summarize"
  }

  /**
   * "Snip" strategy: drop the oldest N completed tool-result payloads that
   * are NOT already compacted, stopping once `targetBytes` have been freed.
   *
   * Cheaper than reactive/summarize — keeps the turn structure intact and
   * only strips the largest old outputs.
   */
  export async function snip(input: { sessionID: string; targetBytes: number }): Promise<number> {
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let freed = 0
    const pruned: MessageV2.ToolPart[] = []
    outer: for (let m = 0; m < msgs.length; m++) {
      const msg = msgs[m]
      if (msg.info.role === "assistant" && msg.info.summary) continue
      for (const part of msg.parts) {
        if (part.type !== "tool") continue
        if (part.state.status !== "completed") continue
        if (part.state.time.compacted) continue
        const size = Token.estimate(part.state.output)
        if (size < 500) continue
        pruned.push(part)
        freed += size
        if (freed >= input.targetBytes) break outer
      }
    }
    for (const part of pruned) {
      if (part.state.status === "completed") {
        part.state.time.compacted = Date.now()
        await Session.updatePart(part)
      }
    }
    log.info("snip", { sessionID: input.sessionID, freed, pruned: pruned.length })
    return freed
  }

  /**
   * Run the selected strategy. Fires PreCompact/PostCompact lifecycle hooks
   * around the operation so settings.json hooks can intercept or observe
   * compaction events.
   */
  export async function run(input: {
    sessionID: string
    strategy: Strategy
    budget: BudgetSnapshot
  }): Promise<{ droppedTokens: number; strategy: Strategy }> {
    if (input.strategy === "none") return { droppedTokens: 0, strategy: "none" }

    const preDecision = await HookLifecycle.dispatch({
      event: "PreCompact",
      sessionID: input.sessionID,
      cwd: Instance.directory,
      timestamp: Date.now(),
      strategy: input.strategy,
    })
    if (preDecision.decision === "block") {
      log.info("compaction blocked by PreCompact hook", {
        sessionID: input.sessionID,
        strategy: input.strategy,
        reason: preDecision.reason,
      })
      return { droppedTokens: 0, strategy: "none" }
    }

    let droppedTokens = 0
    try {
      switch (input.strategy) {
        case "microcompact":
          await SessionCompaction.microCompact({ sessionID: input.sessionID, keepRecent: 5 })
          break
        case "snip":
          droppedTokens = await snip({
            sessionID: input.sessionID,
            targetBytes: Math.max(4000, Math.floor(input.budget.usable * 0.15)),
          })
          break
        case "reactive":
          // Reactive = microcompact + snip, done in one shot so the next
          // turn has headroom without a full summarize round trip.
          await SessionCompaction.microCompact({ sessionID: input.sessionID, keepRecent: 3 })
          droppedTokens += await snip({
            sessionID: input.sessionID,
            targetBytes: Math.max(8000, Math.floor(input.budget.usable * 0.2)),
          })
          break
        case "summarize":
          // End-of-turn summarization is handled by the existing
          // SessionCompaction.process path; fire a marker here so hooks
          // see a PostCompact for every strategy, including summarize.
          droppedTokens = input.budget.used - input.budget.usable
          break
      }
    } catch (e) {
      log.error("compaction strategy failed", { strategy: input.strategy, error: e })
    }

    await HookLifecycle.dispatch({
      event: "PostCompact",
      sessionID: input.sessionID,
      cwd: Instance.directory,
      timestamp: Date.now(),
      strategy: input.strategy,
      droppedTokens,
    })

    return { droppedTokens, strategy: input.strategy }
  }
}
