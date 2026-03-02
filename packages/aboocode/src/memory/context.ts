import { MarkdownStore } from "./markdown-store"

const MEMORY_INSTRUCTION = `## Project Memory

You have a persistent memory directory at \`{memoryDir}/\`. Its contents persist across conversations.

As you work, consult your memory files to build on previous experience.

**MEMORY.md** is the main index file — it's loaded into your context automatically (first 200 lines).
- Read topic files with the Read tool when you need details
- Write/edit memory files to save important knowledge
- Keep MEMORY.md concise; move detailed notes to topic files

**Before starting any new task:**
- Review the memory context below for relevant decisions, patterns, and lessons`

const MEMORY_INSTRUCTION_EMPTY = `## Project Memory

You have a persistent memory directory at \`{memoryDir}/\`.
No memories have been recorded yet. As you work, save important decisions, patterns, and lessons to MEMORY.md in the memory directory.`

export function buildContextStrings(): string[] {
  const content = MarkdownStore.readMemory()
  const memoryDir = MarkdownStore.getDir()

  if (!content) {
    return [MEMORY_INSTRUCTION_EMPTY.replace("{memoryDir}", memoryDir)]
  }

  const lines = content.split("\n").slice(0, 200)
  const topicFiles = MarkdownStore.listTopicFiles()
  const topicNote =
    topicFiles.length > 0
      ? `\n\nTopic files available: ${topicFiles.join(", ")}`
      : ""

  return [
    `${MEMORY_INSTRUCTION.replace("{memoryDir}", memoryDir)}${topicNote}\n\n${lines.join("\n")}`,
  ]
}
