/**
 * SessionMemory round-trip around compaction.
 *
 * Phase 11: mirrors Claude Code's pattern of "extract memories before
 * summarize, re-inject after." Without this, summarize can lose the very
 * facts the user wanted to carry forward (preferences, corrections, domain
 * context). With it, the post-compaction turn sees a compact_boundary +
 * memory reinjection block at the top of the next user message.
 *
 * Flow:
 *   1. captureBefore(sessionID) — called just before the "summarize"
 *      compaction strategy fires. Pulls the tail of the recent
 *      conversation, asks findRelevantMemories for up to 5 relevant
 *      memory files, and stashes a formatted block on
 *      SessionCompaction.postCompactionState.
 *   2. After summarize completes, SessionCompaction.buildIdentityPrompt()
 *      appends the stashed block so the model re-enters the post-compact
 *      turn with its memory context intact.
 *
 * Failure is never fatal — we silently fall through on any error so a
 * compaction never fails because memory recall failed.
 */

import { readFileSync } from "fs"
import { Log } from "@/util/log"
import { Session } from "."
import { SessionCompaction } from "./compaction"
import {
  findRelevantMemories,
  getAutoMemPath,
  isAutoMemoryEnabled,
  memoryFreshnessText,
} from "@/memory/memdir"

const log = Log.create({ service: "session.memory-roundtrip" })

const MAX_MESSAGE_CHARS = 4000
const MAX_MEMORIES = 5

export namespace SessionMemoryRoundTrip {
  /**
   * Extract a compact query from the tail of the session to feed memory
   * relevance ranking. Prefers the last user message; falls back to the
   * last 2 assistant text parts if there's no recent user input.
   */
  async function tailQuery(sessionID: string): Promise<string> {
    try {
      const msgs = await Session.messages({ sessionID })
      // Scan backwards for the most recent user message with text content.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (msg.info.role !== "user") continue
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => ("text" in p ? (p as { text: string }).text : ""))
          .join("\n")
          .trim()
        if (text) return text.slice(0, MAX_MESSAGE_CHARS)
      }
      // Fallback: last assistant text for context-continuity hints.
      const assistantText: string[] = []
      for (let i = msgs.length - 1; i >= 0 && assistantText.length < 2; i--) {
        const msg = msgs[i]
        if (msg.info.role !== "assistant") continue
        for (const p of msg.parts) {
          if (p.type === "text" && "text" in p) assistantText.push((p as { text: string }).text)
        }
      }
      return assistantText.join("\n").slice(0, MAX_MESSAGE_CHARS)
    } catch (e) {
      log.warn("tailQuery failed", { error: e })
      return ""
    }
  }

  /**
   * Capture memories relevant to the tail of the session and stash them
   * on the post-compaction state. Call this BEFORE running the summarize
   * strategy.
   */
  export async function captureBefore(sessionID: string): Promise<void> {
    try {
      if (!(await isAutoMemoryEnabled())) return
      const query = await tailQuery(sessionID)
      if (!query) return

      const dir = await getAutoMemPath()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8_000)
      let relevant: Awaited<ReturnType<typeof findRelevantMemories>> = []
      try {
        relevant = await findRelevantMemories(query, dir, controller.signal, [], new Set())
      } finally {
        clearTimeout(timeout)
      }
      if (relevant.length === 0) return

      const blocks: string[] = []
      for (const r of relevant.slice(0, MAX_MEMORIES)) {
        try {
          const body = readFileSync(r.path, "utf-8")
          const freshness = memoryFreshnessText(r.mtimeMs)
          blocks.push(
            `<memory path="${r.path}"${freshness ? ` freshness="${freshness}"` : ""}>\n${body.trim()}\n</memory>`,
          )
        } catch {
          // skip unreadable
        }
      }
      if (blocks.length === 0) return

      const reinjection = [
        "<compact_boundary/>",
        "Memory reinjection — the following memories were pinned before compaction and are re-attached so continuity isn't lost:",
        ...blocks,
      ].join("\n\n")

      // Merge with any existing post-compaction state (identity re-injection).
      const existing = SessionCompaction.getPostCompaction(sessionID)
      SessionCompaction.setPostCompaction(sessionID, {
        agent: existing?.agent ?? "",
        agentDescription: existing?.agentDescription,
        cwd: existing?.cwd ?? process.cwd(),
        memoryReinjection: reinjection,
      })
      log.info("captured memory reinjection", { sessionID, blocks: blocks.length })
    } catch (e) {
      log.warn("captureBefore failed — continuing without memory reinjection", { error: e })
    }
  }
}
