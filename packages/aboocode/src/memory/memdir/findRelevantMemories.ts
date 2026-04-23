/**
 * Query-time memory recall via LLM ranking.
 *
 * Ported from claude-code-leak/src/memdir/findRelevantMemories.ts.
 *
 * Scans the memory directory for headers, then asks a small-fast model
 * to pick up to 5 memories relevant to the user's query. Excludes
 * MEMORY.md (already in the system prompt) and memories surfaced in
 * prior turns (alreadySurfaced).
 *
 * The small model is resolved via Provider.getSmallModel; if unavailable,
 * we fall back to a best-effort heuristic (top-5 newest matching any
 * query keyword).
 */

import { generateObject, type LanguageModelV2 } from "ai"
import { z } from "zod"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { formatMemoryManifest, type MemoryHeader, scanMemoryFiles } from "./memoryScan"

const log = Log.create({ service: "memory.memdir.recall" })

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to an AI coding agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to the agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (the agent is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.`

const SELECTION_SCHEMA = z.object({
  selected_memories: z.array(z.string()),
})

/**
 * Find memory files relevant to a query. Returns absolute paths + mtime
 * of the most relevant memories (up to 5). Excludes MEMORY.md and
 * previously-surfaced paths.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter((m) => !alreadySurfaced.has(m.filePath))
  if (memories.length === 0) return []

  const selectedFilenames = await selectRelevantMemories(query, memories, signal, recentTools)
  const byFilename = new Map(memories.map((m) => [m.filename, m]))
  const selected = selectedFilenames
    .map((filename) => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  return selected.map((m) => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  const validFilenames = new Set(memories.map((m) => m.filename))
  const manifest = formatMemoryManifest(memories)
  const toolsSection = recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(", ")}` : ""

  const language = await resolveSmallLanguageModel()
  if (!language) {
    return heuristicSelect(query, memories).filter((f) => validFilenames.has(f))
  }

  try {
    const result = await generateObject({
      model: language,
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      schema: SELECTION_SCHEMA,
      schemaName: "MemorySelection",
      schemaDescription: "List of memory filenames to surface to the main agent.",
      prompt: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
      abortSignal: signal,
    })
    return result.object.selected_memories.filter((f) => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) return []
    log.warn("selectRelevantMemories failed, falling back to heuristic", { error: e })
    return heuristicSelect(query, memories).filter((f) => validFilenames.has(f))
  }
}

/**
 * Fallback ranker: pick up to 5 of the newest memories whose filename or
 * description contains a word from the query (case-insensitive). Used when
 * no small model is available or the LLM call fails.
 */
function heuristicSelect(query: string, memories: MemoryHeader[]): string[] {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3)
  if (words.length === 0) return memories.slice(0, 5).map((m) => m.filename)
  const scored: { m: MemoryHeader; score: number }[] = []
  for (const m of memories) {
    const hay = (m.filename + " " + (m.description ?? "")).toLowerCase()
    let score = 0
    for (const w of words) if (hay.includes(w)) score++
    if (score > 0) scored.push({ m, score })
  }
  scored.sort((a, b) => b.score - a.score || b.m.mtimeMs - a.m.mtimeMs)
  return scored.slice(0, 5).map((s) => s.m.filename)
}

async function resolveSmallLanguageModel(): Promise<LanguageModelV2 | null> {
  try {
    const config = await Config.get()
    const primary = config.model
    if (!primary) return null
    const parsed = Provider.parseModel(primary)
    const small =
      (await Provider.getSmallModel(parsed.providerID)) ??
      (await Provider.getModel(parsed.providerID, parsed.modelID))
    if (!small) return null
    return await Provider.getLanguage(small)
  } catch (e) {
    log.warn("resolveSmallLanguageModel failed", { error: e })
    return null
  }
}
