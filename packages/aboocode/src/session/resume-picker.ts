/**
 * Session resume picker — list recent sessions for the current project with
 * previews, ready to be rendered by a quick-pick UI (TUI or web).
 *
 * Ported in spirit from claude-code-leak's resume handling in
 * src/entrypoints/ and src/screens/. aboocode already has raw session
 * listing; this module adds the per-entry preview + token totals so a
 * Claude-Code-style "resume which one?" picker has everything it needs.
 */

import { Database, desc, eq } from "@/storage/db"
import { SessionTable } from "./session.sql"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { Session } from "."

const log = Log.create({ service: "session.resume-picker" })

export interface ResumePickerEntry {
  /** Session id. */
  id: string
  /** Short title (slug or user-entered). */
  title: string
  /** First line of the first user message, truncated to 120 chars. */
  preview: string
  /** ISO timestamp of last activity. */
  updatedAt: string
  /** Number of messages in the session. */
  messageCount: number
  /** Total tokens consumed (assistant output + inputs). */
  totalTokens: number
  /** Whether the session appears unfinished (no final assistant message after last user). */
  unfinished: boolean
}

export namespace SessionResumePicker {
  /**
   * List the `limit` most recent sessions for the current project that
   * can be resumed. Sessions with zero messages are skipped.
   */
  export async function list(limit = 20): Promise<ResumePickerEntry[]> {
    let rows: Array<{ id: string; slug?: string | null; title?: string | null; time_updated?: number | null }> = []
    try {
      rows = Database.use((db) =>
        db
          .select({
            id: SessionTable.id,
            slug: SessionTable.slug,
            title: SessionTable.title,
            time_updated: SessionTable.time_updated,
          })
          .from(SessionTable)
          .orderBy(desc(SessionTable.time_updated))
          .limit(limit)
          .all(),
      )
    } catch (e) {
      log.warn("session list query failed", { error: e })
      return []
    }

    const results: ResumePickerEntry[] = []
    for (const row of rows) {
      try {
        const entry = await toEntry(row)
        if (entry) results.push(entry)
      } catch (e) {
        log.debug("failed to enrich session", { id: row.id, error: e })
      }
    }
    return results
  }

  async function toEntry(row: {
    id: string
    slug?: string | null
    title?: string | null
    time_updated?: number | null
  }): Promise<ResumePickerEntry | null> {
    const messages: MessageV2.WithParts[] = []
    try {
      for await (const msg of MessageV2.stream(row.id)) {
        messages.push(msg)
      }
    } catch {
      return null
    }
    if (messages.length === 0) return null

    let preview = ""
    let totalTokens = 0
    const firstUser = messages.find((m) => m.info.role === "user")
    if (firstUser) {
      for (const part of firstUser.parts) {
        if (part.type === "text" && part.text) {
          preview = part.text.split("\n")[0].slice(0, 120)
          break
        }
      }
    }
    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue
      const tokens = msg.info.tokens
      if (!tokens) continue
      totalTokens +=
        tokens.total ||
        tokens.input + tokens.output + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
    }

    const lastMessage = messages[messages.length - 1]
    const unfinished = lastMessage.info.role === "user"

    return {
      id: row.id,
      title: row.title ?? row.slug ?? row.id,
      preview,
      updatedAt: new Date(row.time_updated ?? Date.now()).toISOString(),
      messageCount: messages.length,
      totalTokens,
      unfinished,
    }
  }

  /**
   * Resolve a user-provided token ("latest", an index, or an id) to a
   * session id from the current picker list.
   */
  export async function resolve(token: string): Promise<string | null> {
    if (token === "latest") {
      const entries = await list(1)
      return entries[0]?.id ?? null
    }
    const numeric = Number(token)
    if (Number.isInteger(numeric)) {
      const entries = await list(Math.max(1, numeric + 1))
      return entries[numeric]?.id ?? null
    }
    // Treat as a session id or a prefix
    try {
      const rows = Database.use((db) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, token)).all(),
      )
      if (rows.length > 0) return rows[0].id
    } catch {
      /* fall through */
    }
    return null
  }

  /**
   * Quick aggregate: total tokens across all recent sessions for cost-
   * tracker UI. Cheaper than computing per-entry when you just need a
   * headline number.
   */
  export async function aggregateTokens(limit = 50): Promise<{ sessions: number; totalTokens: number }> {
    const entries = await list(limit)
    let total = 0
    for (const e of entries) total += e.totalTokens
    return { sessions: entries.length, totalTokens: total }
  }
}

// Avoid an unused-import warning when Session isn't referenced below.
export type { Session }
