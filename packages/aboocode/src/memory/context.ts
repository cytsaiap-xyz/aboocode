import { existsSync, readdirSync, readFileSync } from "fs"
import path from "path"
import { MarkdownStore } from "./markdown-store"
import {
  findRelevantMemories,
  loadMemoryPrompt,
  memoryFreshnessText,
} from "./memdir"

const MEMORY_INSTRUCTION = `## Project Memory

You have a persistent memory directory at \`{memoryDir}/\`. Its contents persist across conversations.

As you work, consult your memory files to build on previous experience.

**MEMORY.md** is the main index file — it's loaded into your context automatically (first 200 lines).
- Read topic files with the Read tool when you need details
- Write/edit memory files to save important knowledge
- Keep MEMORY.md concise; move detailed notes to topic files
- Session notes from the background observer are in \`sessions/\` subfolder

**Before starting any new task:**
- Review the memory context below for relevant decisions and user preferences
- Memory may be stale — verify claims about files, functions, or flags against current code before acting on them
- A memory that names a specific file path, function, or flag may have been renamed or removed — check before recommending

**What to save (durable):** user preferences, role, feedback, project goals, decisions with rationale, external references, recurring workflows, debugging lessons
**What NOT to save (derivable):** file structure, architecture summaries, coding conventions, dependency info, recent commits, session recaps, implementation details`

const MEMORY_INSTRUCTION_EMPTY = `## Project Memory

You have a persistent memory directory at \`{memoryDir}/\`.
No memories have been recorded yet. As you work, save important non-derivable knowledge (user preferences, project goals, key decisions) to MEMORY.md in the memory directory.
A background observer is recording session notes automatically.`

/**
 * Get the most recent session notes (last 2 sessions, truncated).
 */
function getRecentSessionNotes(): string {
  const dir = MarkdownStore.getDir()
  const sessionsDir = path.join(dir, "sessions")
  if (!existsSync(sessionsDir)) return ""

  try {
    const files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(-2) // last 2 session files

    if (files.length === 0) return ""

    const notes: string[] = []
    for (const file of files) {
      const content = readFileSync(path.join(sessionsDir, file), "utf-8")
      // Truncate each to 100 lines
      const truncated = content.split("\n").slice(0, 100).join("\n")
      notes.push(truncated)
    }

    return `\n\n## Recent Session Notes\n\n${notes.join("\n\n---\n\n")}`
  } catch {
    return ""
  }
}

export function buildContextStrings(): string[] {
  const content = MarkdownStore.readMemory()
  const memoryDir = MarkdownStore.getDir()

  if (!content) {
    const sessionNotes = getRecentSessionNotes()
    return [MEMORY_INSTRUCTION_EMPTY.replace("{memoryDir}", memoryDir) + sessionNotes]
  }

  const lines = content.split("\n").slice(0, 200)
  const topicFiles = MarkdownStore.listTopicFiles()
  const topicNote =
    topicFiles.length > 0
      ? `\n\nTopic files available: ${topicFiles.join(", ")}`
      : ""

  const sessionNotes = getRecentSessionNotes()

  return [
    `${MEMORY_INSTRUCTION.replace("{memoryDir}", memoryDir)}${topicNote}\n\n${lines.join("\n")}${sessionNotes}`,
  ]
}

/**
 * Async path: produce the full Claude-Code-style memdir system prompt.
 * This uses the ported memdir taxonomy (individual or combined mode) and
 * is preferred over buildContextStrings() for new callers that can await.
 * Returns [] if memory is disabled.
 */
export async function buildMemdirSystemPrompt(): Promise<string[]> {
  const prompt = await loadMemoryPrompt()
  return prompt ? [prompt] : []
}

/**
 * Build per-turn "relevant_memories" reminders using the LLM recall selector.
 *
 * Given the user's query and a recent-tool list, asks a small model to pick
 * up to 5 memory files to surface. Returns system-reminder strings that the
 * main-turn builder can prepend to the user message.
 *
 * Silently returns [] on any error — memory recall must never break a turn.
 */
export async function buildRelevantMemoryReminders(
  query: string,
  signal: AbortSignal,
  options: { recentTools?: readonly string[]; alreadySurfaced?: ReadonlySet<string> } = {},
): Promise<{ reminders: string[]; surfaced: string[] }> {
  try {
    if (!query.trim()) return { reminders: [], surfaced: [] }
    const { getAutoMemPath, isAutoMemoryEnabled } = await import("./memdir")
    if (!(await isAutoMemoryEnabled())) return { reminders: [], surfaced: [] }
    const dir = await getAutoMemPath()
    const results = await findRelevantMemories(
      query,
      dir,
      signal,
      options.recentTools ?? [],
      options.alreadySurfaced ?? new Set(),
    )
    if (results.length === 0) return { reminders: [], surfaced: [] }
    const reminders: string[] = []
    const surfaced: string[] = []
    for (const r of results) {
      try {
        const body = readFileSync(r.path, "utf-8")
        const freshness = memoryFreshnessText(r.mtimeMs)
        const header = `<system-reminder>\nRelevant memory from ${r.path}${freshness ? ` — ${freshness}` : ""}\n\n${body}\n</system-reminder>`
        reminders.push(header)
        surfaced.push(r.path)
      } catch {
        /* skip unreadable */
      }
    }
    return { reminders, surfaced }
  } catch {
    return { reminders: [], surfaced: [] }
  }
}
