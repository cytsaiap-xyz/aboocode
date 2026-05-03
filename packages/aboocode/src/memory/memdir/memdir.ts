/**
 * Core memdir loader and prompt builder.
 *
 * Ported from claude-code-leak/src/memdir/memdir.ts. Responsibilities:
 * - Truncate MEMORY.md to line + byte caps before injection
 * - Ensure the memory directory exists (harness guarantee for the Write tool)
 * - Build the system-prompt memory section, with the behavioral type taxonomy
 * - Dispatch between individual-only and combined (team+private) modes
 */

import { mkdir, readFile, stat } from "fs/promises"
import path from "path"
import { Log } from "@/util/log"
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from "./memoryTypes"
import {
  ensureAutoMemDir,
  getAutoMemEntrypoint,
  getAutoMemPath,
  isAutoMemoryEnabled,
} from "./paths"

const log = Log.create({ service: "memory.memdir" })

export const ENTRYPOINT_NAME = "MEMORY.md"
export const MAX_ENTRYPOINT_LINES = 200
// ~125 chars/line at 200 lines — the byte cap catches long-line indexes that
// slip past the line cap.
export const MAX_ENTRYPOINT_BYTES = 25_000
const AUTO_MEM_DISPLAY_NAME = "auto memory"

export const DIR_EXISTS_GUIDANCE =
  "This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence)."
export const DIRS_EXIST_GUIDANCE =
  "Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence)."

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Truncate MEMORY.md content to line and byte caps, appending a warning that
 * names which cap fired. Line-truncates first (natural boundary), then
 * byte-truncates at the last newline before the cap so we don't cut mid-line.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split("\n")
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  let truncated = wasLineTruncated ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/**
 * Idempotent mkdir -p. Called from loadMemoryPrompt once per session so the
 * model can always Write without checking existence first.
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  try {
    await mkdir(memoryDir, { recursive: true })
  } catch (e) {
    log.error("ensureMemoryDirExists failed", { memoryDir, error: e })
  }
}

/**
 * Build the typed-memory behavioral instructions (without MEMORY.md content).
 * Individual-only variant: no <scope> tags in type blocks.
 *
 * Used by both buildMemoryPrompt (agent memory, includes content) and
 * loadMemoryPrompt (system prompt, content injected via user context).
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const howToSave = skipIndex
    ? [
        "## How to save memories",
        "",
        "Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
        "",
        ...MEMORY_FRONTMATTER_EXAMPLE,
        "",
        "- Keep the name, description, and type fields in memory files up-to-date with the content",
        "- Organize memory semantically by topic, not chronologically",
        "- Update or remove memories that turn out to be wrong or outdated",
        "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
      ]
    : [
        "## How to save memories",
        "",
        "Saving a memory is a two-step process:",
        "",
        "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
        "",
        ...MEMORY_FRONTMATTER_EXAMPLE,
        "",
        `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
        "",
        `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
        "- Keep the name, description, and type fields in memory files up-to-date with the content",
        "- Organize memory semantically by topic, not chronologically",
        "- Update or remove memories that turn out to be wrong or outdated",
        "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
      ]

  const lines: string[] = [
    `# ${displayName}`,
    "",
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
    ...howToSave,
    "",
    ...WHEN_TO_ACCESS_SECTION,
    "",
    ...TRUSTING_RECALL_SECTION,
    "",
    "## Memory and other forms of persistence",
    "Memory is one of several persistence mechanisms available to you. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
    "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach, use a Plan rather than saving to memory.",
    "- When to use or update tasks instead of memory: When you need to break work into discrete steps or track progress, use tasks instead of memory. Tasks are for current-conversation work; memory is for future conversations.",
    "",
    ...(extraGuidelines ?? []),
    "",
  ]

  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * Build the typed-memory prompt with MEMORY.md content included. Used by
 * agent memory which has no separate content-injection pathway.
 */
export async function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): Promise<string> {
  const { displayName, memoryDir, extraGuidelines } = params
  const entrypoint = path.join(memoryDir, ENTRYPOINT_NAME)

  let entrypointContent = ""
  try {
    entrypointContent = await readFile(entrypoint, "utf-8")
  } catch {
    /* no memory file yet */
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    log.info("memdir loaded", {
      memory_type: displayName === AUTO_MEM_DISPLAY_NAME ? "auto" : "agent",
      line_count: t.lineCount,
      byte_count: t.byteCount,
      was_truncated: t.wasLineTruncated,
    })
    lines.push(`## ${ENTRYPOINT_NAME}`, "", t.content)
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      "",
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  return lines.join("\n")
}

/**
 * Build the "Searching past context" section. Describes grep invocations
 * so the model can find old memories or session transcripts.
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  return [
    "## Searching past context",
    "",
    "When looking for past context:",
    "1. Search topic files in your memory directory:",
    "```",
    `grep with pattern="<search term>" path="${autoMemDir}" glob="*.md"`,
    "```",
    "2. Session transcript logs (last resort — large files, slow):",
    "```",
    `grep with pattern="<search term>" path="${path.join(autoMemDir, "logs")}" glob="*.md"`,
    "```",
    "Use narrow search terms (error messages, file paths, function names) rather than broad keywords.",
    "",
  ]
}

/**
 * Load the unified memory prompt for inclusion in the system prompt.
 * Dispatches between combined (auto+team) and auto-only modes.
 * Returns null when auto memory is disabled.
 */
export async function loadMemoryPrompt(): Promise<string | null> {
  if (!(await isAutoMemoryEnabled())) {
    log.info("memdir disabled")
    return null
  }

  // Lazy import to avoid a cycle (teamMemPaths imports paths).
  const { isTeamMemoryEnabled, getTeamMemPath } = await import("./teamMemPaths")
  const { buildCombinedMemoryPrompt } = await import("./teamMemPrompts")

  if (await isTeamMemoryEnabled()) {
    const autoDir = await getAutoMemPath()
    const teamDir = await getTeamMemPath()
    await ensureMemoryDirExists(teamDir)
    await ensureMemoryDirExists(autoDir)
    log.info("memdir loaded (combined)", { autoDir, teamDir })
    return await buildCombinedMemoryPrompt()
  }

  const autoDir = await getAutoMemPath()
  await ensureAutoMemDir()
  log.info("memdir loaded (individual)", { autoDir })
  return buildMemoryLines(AUTO_MEM_DISPLAY_NAME, autoDir).join("\n")
}

/**
 * Phase 13.6: agent-aware variant.
 *
 *   shared    → identical to loadMemoryPrompt() (project-wide memdir)
 *   isolated  → only the agent's per-agent partition
 *   inherit   → both, with the per-agent block appended after the shared
 *               block (so isolated facts override or supplement shared
 *               ones)
 *
 * Falls back to shared if anything goes wrong (per-agent dir missing,
 * sanitized name empty, etc.) — memory must never break a turn.
 */
export async function loadAgentMemoryPrompt(
  agent: string,
  scope: "shared" | "isolated" | "inherit" = "shared",
): Promise<string | null> {
  if (!(await isAutoMemoryEnabled())) return null
  if (scope === "shared") return loadMemoryPrompt()

  const { getAgentMemPath } = await import("./paths")
  let agentBlock: string | null = null
  try {
    const dir = await getAgentMemPath(agent)
    await ensureMemoryDirExists(dir)
    const block = buildMemoryLines(`${AUTO_MEM_DISPLAY_NAME} (agent: ${agent})`, dir).join("\n")
    if (block.trim()) agentBlock = block
  } catch (e) {
    log.warn("loadAgentMemoryPrompt agent-block failed; falling back to shared", { agent, error: e })
    return loadMemoryPrompt()
  }

  if (scope === "isolated") return agentBlock ?? ""

  // inherit: shared first, agent second
  const shared = await loadMemoryPrompt()
  if (!shared && !agentBlock) return null
  if (!agentBlock) return shared
  if (!shared) return agentBlock
  return `${shared}\n\n${agentBlock}`
}

/**
 * Read + truncate MEMORY.md content only. Used by the user-context builder
 * which injects the index into the running conversation rather than the
 * (cached) system prompt.
 */
export async function loadMemoryContent(): Promise<{ content: string; truncation: EntrypointTruncation } | null> {
  if (!(await isAutoMemoryEnabled())) return null
  try {
    const entrypoint = await getAutoMemEntrypoint()
    const raw = await readFile(entrypoint, "utf-8")
    if (!raw.trim()) return null
    const truncation = truncateEntrypointContent(raw)
    return { content: truncation.content, truncation }
  } catch {
    return null
  }
}

export async function getMemoryFileMtime(filePath: string): Promise<number | null> {
  try {
    const s = await stat(filePath)
    return s.mtimeMs
  } catch {
    return null
  }
}
