/**
 * Public entrypoint for the memdir subsystem.
 *
 * This barrel re-exports the ported Claude Code memdir modules so that the
 * top-level Memory namespace and other subsystems can consume them via a
 * single path (`@/memory/memdir`).
 *
 * Module map (all ported from claude-code-leak/src/memdir/):
 *   - memdir.ts              → entrypoint truncation, prompt builders, loaders
 *   - memoryTypes.ts         → 4-type taxonomy (user, feedback, project, reference)
 *   - memoryAge.ts           → staleness warnings (today / N days ago)
 *   - memoryScan.ts          → frontmatter scanning + manifest formatting
 *   - findRelevantMemories.ts → LLM-based recall selection
 *   - paths.ts               → path resolution + security validation
 *   - teamMemPaths.ts        → team directory containment checks
 *   - teamMemPrompts.ts      → combined private+team prompt builder
 */

export {
  buildMemoryLines,
  buildMemoryPrompt,
  buildSearchingPastContextSection,
  DIR_EXISTS_GUIDANCE,
  DIRS_EXIST_GUIDANCE,
  ensureMemoryDirExists,
  ENTRYPOINT_NAME,
  loadMemoryContent,
  loadMemoryPrompt,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
  getMemoryFileMtime,
  type EntrypointTruncation,
} from "./memdir"

export {
  memoryAge,
  memoryAgeDays,
  memoryFreshnessNote,
  memoryFreshnessText,
} from "./memoryAge"

export {
  MEMORY_DRIFT_CAVEAT,
  MEMORY_FRONTMATTER_EXAMPLE,
  MEMORY_TYPES,
  parseMemoryType,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
  type MemoryType,
} from "./memoryTypes"

export {
  formatMemoryManifest,
  scanMemoryFiles,
  type MemoryHeader,
} from "./memoryScan"

export { findRelevantMemories, type RelevantMemory } from "./findRelevantMemories"

export {
  autoMemDirExists,
  AUTO_MEM_ENTRYPOINT_NAME,
  ensureAutoMemDir,
  getAutoMemDailyLogPath,
  getAutoMemEntrypoint,
  getAutoMemPath,
  getAutoMemPathSync,
  getMemoryBaseDir,
  hasAutoMemPathOverride,
  isAutoMemoryEnabled,
  isAutoMemoryEnabledSync,
  isAutoMemPath,
} from "./paths"

export {
  getTeamMemEntrypoint,
  getTeamMemPath,
  isTeamMemFile,
  isTeamMemoryEnabled,
  isTeamMemPath,
  PathTraversalError,
  validateTeamMemKey,
  validateTeamMemWritePath,
} from "./teamMemPaths"

export { buildCombinedMemoryPrompt } from "./teamMemPrompts"
