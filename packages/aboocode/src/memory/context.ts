import type { MemoryTypes } from "./types"

const MEMORY_INSTRUCTION = `## Project Memory

You have access to a persistent memory system that stores knowledge from previous sessions.

**Before starting any new task, planning, or writing code:**
- Use \`memory_search\` to find relevant decisions, patterns, bugfixes, and lessons from previous sessions
- Check if similar work has been done before to avoid repeating mistakes or contradicting past decisions

**While working:**
- Use \`memory_add\` to record important decisions, patterns discovered, bugs fixed, or lessons learned
- Use \`memory_entity_add\` and \`memory_relation_add\` to track project components and their relationships

**Recent memories from this project:**`

export function buildContextStrings(memories: MemoryTypes.MemoryEntry[]): string[] {
  if (memories.length === 0) {
    return [
      `## Project Memory\n\nYou have access to a persistent memory system. Use \`memory_search\` before starting new tasks to find relevant context from previous sessions. Use \`memory_add\` to record important decisions and lessons learned.`,
    ]
  }

  const lines = memories.map((m) => {
    const tags = m.tags.length > 0 ? ` (${m.tags.join(", ")})` : ""
    return `- [${m.type}] ${m.title}${tags}\n  ${m.content}`
  })

  return [`${MEMORY_INSTRUCTION}\n\n${lines.join("\n")}`]
}
