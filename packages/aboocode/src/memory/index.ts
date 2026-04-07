import { MarkdownStore } from "./markdown-store"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session"
import { buildContextStrings } from "./context"
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
