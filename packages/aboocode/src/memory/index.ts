import { MarkdownStore } from "./markdown-store"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session"
import { buildContextStrings, buildMemdirSystemPrompt, buildRelevantMemoryReminders } from "./context"
import { UsageLog } from "@/usage-log"
import { DebugLog } from "@/debug-log"
import { Observer } from "./observer"

const log = Log.create({ service: "memory" })

export namespace Memory {
  async function isEnabled(): Promise<boolean> {
    const config = await Config.get()
    return config.memory?.enabled !== false
  }

  /**
   * Get the memory directory path for the current project.
   */
  export function dir(): string {
    return MarkdownStore.getDir()
  }

  /**
   * Get the path to MEMORY.md for the current project.
   */
  export function getMemoryPath(): string {
    return MarkdownStore.getMemoryPath()
  }

  /**
   * Read MEMORY.md (first 200 lines) and build context strings for injection.
   */
  export async function buildContext(): Promise<string[]> {
    UsageLog.record("memory", "buildContext")
    if (!(await isEnabled())) return []
    const ctx = buildContextStrings()
    DebugLog.memoryBuildContext(ctx.length)
    return ctx
  }

  /**
   * Preferred: build the Claude-Code-style memdir system prompt with the full
   * typed-memory taxonomy, recall guidance, and team/private dispatch.
   * Returns [] if memory is disabled.
   *
   * Phase 13.6: pass `agent` (and optional scope) to read from the
   * agent's per-agent partition instead of the shared project memdir.
   * Agents whose `Agent.Info.memoryScope === "isolated"` get only their
   * own memory; `inherit` gets both, `shared` (default) gets the project
   * memdir as before.
   */
  export async function buildSystemPrompt(input?: {
    agent?: string
    scope?: "shared" | "isolated" | "inherit"
  }): Promise<string[]> {
    UsageLog.record("memory", "buildSystemPrompt")
    if (!(await isEnabled())) return []
    if (input?.agent && input.scope && input.scope !== "shared") {
      const { loadAgentMemoryPrompt } = await import("./memdir")
      const prompt = await loadAgentMemoryPrompt(input.agent, input.scope)
      return prompt ? [prompt] : []
    }
    return await buildMemdirSystemPrompt()
  }

  /**
   * Per-turn recall: given the user's query, ask a small model to surface
   * up to 5 relevant memory files. Returns system-reminder strings ready
   * to prepend to the turn.
   */
  export async function recall(
    query: string,
    signal: AbortSignal,
    options: { recentTools?: readonly string[]; alreadySurfaced?: ReadonlySet<string> } = {},
  ): Promise<{ reminders: string[]; surfaced: string[] }> {
    UsageLog.record("memory", "recall")
    if (!(await isEnabled())) return { reminders: [], surfaced: [] }
    return await buildRelevantMemoryReminders(query, signal, options)
  }

  /**
   * Append a note to MEMORY.md (used by auto-extraction).
   */
  export async function append(note: string): Promise<void> {
    UsageLog.record("memory", "append", { noteLength: note.length })
    if (!(await isEnabled())) return
    DebugLog.memoryAppend(note.length, note)
    const existing = MarkdownStore.readMemory()
    const updated = existing ? existing.trimEnd() + "\n\n" + note.trim() + "\n" : note.trim() + "\n"
    MarkdownStore.writeMemory(updated)
    log.info("appended to MEMORY.md")
  }

  // --- Initialization ---

  let initialized = false

  export function init(): void {
    if (initialized) return
    initialized = true
    UsageLog.record("memory", "init")
    DebugLog.memoryInit()

    // Start background observer (meeting recorder)
    Observer.init()

    Bus.subscribe(SessionStatus.Event.Status, async (event) => {
      if (event.properties.status.type !== "idle") return
      try {
        if (!(await isEnabled())) return
        const config = await Config.get()
        if (config.memory?.autoExtract === false) return

        // Clean up observer session notes (do not merge to MEMORY.md — only the
        // structured extractor should write durable memory to avoid double-writes)
        Observer.cleanup(event.properties.sessionID)

        // Dynamic import to avoid circular dependency
        const { extractMemories } = await import("./extract")
        await extractMemories(event.properties.sessionID)
      } catch (e) {
        log.error("memory extraction failed", { error: e })
      }
    })

    // No session deletion cleanup needed for markdown store — files persist

    log.info("memory system initialized (with observer)")
  }
}
