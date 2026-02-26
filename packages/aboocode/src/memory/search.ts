import type { MemoryTypes } from "./types"

const JACCARD_THRESHOLD = 0.35

function getWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  )
}

export function jaccardSimilarity(text1: string, text2: string): number {
  const words1 = getWords(text1)
  const words2 = getWords(text2)
  if (words1.size === 0 && words2.size === 0) return 1
  if (words1.size === 0 || words2.size === 0) return 0

  let intersection = 0
  for (const word of words1) {
    if (words2.has(word)) intersection++
  }
  return intersection / (words1.size + words2.size - intersection)
}

export function isDuplicate(newContent: string, existingContent: string): boolean {
  return jaccardSimilarity(newContent, existingContent) >= JACCARD_THRESHOLD
}

export function searchText(query: string, entries: MemoryTypes.MemoryEntry[]): MemoryTypes.MemoryEntry[] {
  const queryWords = getWords(query)
  if (queryWords.size === 0) return entries

  const scored = entries.map((entry) => {
    const text = `${entry.title} ${entry.content} ${entry.tags.join(" ")}`
    const entryWords = getWords(text)
    let score = 0
    for (const word of queryWords) {
      for (const entryWord of entryWords) {
        if (entryWord.includes(word) || word.includes(entryWord)) {
          score++
          break
        }
      }
    }
    return { entry, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.entry)
}

export function searchEntities(query: string, entities: MemoryTypes.Entity[]): MemoryTypes.Entity[] {
  const queryWords = getWords(query)
  if (queryWords.size === 0) return entities

  const scored = entities.map((entity) => {
    const text = `${entity.name} ${entity.type} ${entity.observations.join(" ")} ${entity.tags.join(" ")}`
    const entryWords = getWords(text)
    let score = 0
    for (const word of queryWords) {
      for (const entryWord of entryWords) {
        if (entryWord.includes(word) || word.includes(entryWord)) {
          score++
          break
        }
      }
    }
    return { entity, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.entity)
}
