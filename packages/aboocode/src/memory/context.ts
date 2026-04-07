import { existsSync, readdirSync, readFileSync } from "fs"
import path from "path"
import { MarkdownStore } from "./markdown-store"

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
