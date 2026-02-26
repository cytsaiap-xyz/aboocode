import type { MemoryTypes } from "./types"

export function buildContextStrings(memories: MemoryTypes.MemoryEntry[]): string[] {
  if (memories.length === 0) return []

  const lines = memories.map((m) => {
    const tags = m.tags.length > 0 ? ` (${m.tags.join(", ")})` : ""
    return `- [${m.type}] ${m.title}${tags}\n  ${m.content}`
  })

  return [
    `## Project Memory\n\nThe following memories were recorded from previous sessions. Use them to inform your work:\n\n${lines.join("\n")}`,
  ]
}
