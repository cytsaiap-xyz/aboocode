/**
 * Memory-directory scanning primitives.
 * Ported from claude-code-leak/src/memdir/memoryScan.ts.
 *
 * Scans a memory directory for .md files, parses their frontmatter, and
 * returns a header list sorted newest-first (capped at MAX_MEMORY_FILES).
 * Shared by findRelevantMemories (query-time recall) and any background
 * extraction agent that needs a pre-computed listing.
 */

import { readFile, readdir, stat } from "fs/promises"
import { basename, join } from "path"
import { type MemoryType, parseMemoryType } from "./memoryTypes"

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/**
 * Minimal YAML frontmatter parser. Extracts `key: value` pairs from the
 * first `---`-delimited block at the top of a document. Sufficient for
 * description/type/name fields; does not support nested structures.
 */
function parseFrontmatter(content: string, _filePath: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {}
  if (!content.startsWith("---")) return { frontmatter, body: content }
  const lines = content.split("\n")
  if (lines[0].trim() !== "---") return { frontmatter, body: content }
  let end = -1
  for (let i = 1; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
    if (lines[i].trim() === "---") {
      end = i
      break
    }
  }
  if (end === -1) return { frontmatter, body: content }
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1).trim()
    // Strip simple quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) frontmatter[key] = value
  }
  const body = lines.slice(end + 1).join("\n")
  return { frontmatter, body }
}

async function readFirstLines(filePath: string, maxLines: number): Promise<{ content: string; mtimeMs: number }> {
  const [raw, st] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)])
  const lines = raw.split("\n").slice(0, maxLines)
  return { content: lines.join("\n"), mtimeMs: st.mtimeMs }
}

/**
 * Recursively collect `.md` files (excluding MEMORY.md) under `root`.
 * `relativePath` is returned relative to `root` for presentation.
 */
async function collectMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = []
  async function walk(dir: string, prefix: string) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? join(prefix, entry.name) : entry.name
      if (entry.isDirectory()) {
        // Skip the logs subtree (used by the daily-log observer)
        if (entry.name === "logs") continue
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile() && entry.name.endsWith(".md") && basename(entry.name) !== "MEMORY.md") {
        results.push(rel)
      }
    }
  }
  await walk(root, "")
  return results
}

/**
 * Scan a memory directory, parse frontmatter, and return headers sorted
 * newest-first. Failures on individual files are skipped (not fatal).
 */
export async function scanMemoryFiles(memoryDir: string, signal: AbortSignal): Promise<MemoryHeader[]> {
  try {
    const mdFiles = await collectMarkdownFiles(memoryDir)
    if (signal.aborted) return []

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFirstLines(filePath, FRONTMATTER_MAX_LINES)
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter((r): r is PromiseFulfilledResult<MemoryHeader> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/**
 * Format memory headers as a text manifest: one line per file with
 * `[type] filename (timestamp): description`. Used by the recall selector
 * prompt and any extraction-agent prompt.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : ""
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description ? `- ${tag}${m.filename} (${ts}): ${m.description}` : `- ${tag}${m.filename} (${ts})`
    })
    .join("\n")
}
