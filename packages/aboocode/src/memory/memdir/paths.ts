/**
 * Memory path resolution + security validation.
 *
 * Ported from claude-code-leak/src/memdir/paths.ts and adapted for aboocode:
 * - Uses Global.Path.data/memory instead of ~/.claude
 * - Uses aboocode project key (Instance.project.id) instead of sanitized cwd
 * - Respects ABOOCODE_DISABLE_AUTO_MEMORY + ABOOCODE_SIMPLE + config settings
 *
 * SECURITY NOTES (carried over from Claude Code):
 * - validateMemoryPath rejects relative paths, Windows drive-roots ("C:\\"),
 *   UNC paths, null bytes, and near-root paths (length < 3).
 * - All returned paths are NFC-normalized and end with exactly one separator.
 */

import { existsSync } from "fs"
import { homedir } from "os"
import path, { isAbsolute, join, normalize, sep } from "path"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

const log = Log.create({ service: "memory.memdir.paths" })

const AUTO_MEM_DIRNAME = "memory"
export const AUTO_MEM_ENTRYPOINT_NAME = "MEMORY.md"

function isEnvTruthy(v: string | undefined): boolean {
  if (!v) return false
  const lower = v.toLowerCase()
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on"
}

function isEnvDefinedFalsy(v: string | undefined): boolean {
  if (v === undefined) return false
  const lower = v.toLowerCase()
  return lower === "0" || lower === "false" || lower === "no" || lower === "off"
}

/**
 * Whether auto-memory features are enabled. Priority chain (first wins):
 *   1. ABOOCODE_DISABLE_AUTO_MEMORY env var
 *   2. ABOOCODE_SIMPLE → off
 *   3. ABOOCODE_REMOTE without ABOOCODE_REMOTE_MEMORY_DIR → off
 *   4. config.memory.enabled from config file
 *   5. Default: enabled
 */
export async function isAutoMemoryEnabled(): Promise<boolean> {
  const envVal = process.env.ABOOCODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true
  if (isEnvTruthy(process.env.ABOOCODE_SIMPLE)) return false
  if (isEnvTruthy(process.env.ABOOCODE_REMOTE) && !process.env.ABOOCODE_REMOTE_MEMORY_DIR) {
    return false
  }
  try {
    const config = await Config.get()
    if (config.memory?.enabled === false) return false
  } catch {
    /* config not yet initialized — fall through */
  }
  return true
}

/**
 * Synchronous variant for paths that can't await (path validation helpers).
 * Only checks env vars; config.memory.enabled is consulted by async callers.
 */
export function isAutoMemoryEnabledSync(): boolean {
  const envVal = process.env.ABOOCODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true
  if (isEnvTruthy(process.env.ABOOCODE_SIMPLE)) return false
  if (isEnvTruthy(process.env.ABOOCODE_REMOTE) && !process.env.ABOOCODE_REMOTE_MEMORY_DIR) {
    return false
  }
  return true
}

/**
 * Returns the base directory for persistent memory storage.
 * Resolution order:
 *   1. ABOOCODE_REMOTE_MEMORY_DIR env var (explicit override for remote workers)
 *   2. Global.Path.data (XDG_DATA_HOME/aboocode by default)
 */
export function getMemoryBaseDir(): string {
  if (process.env.ABOOCODE_REMOTE_MEMORY_DIR) {
    return process.env.ABOOCODE_REMOTE_MEMORY_DIR
  }
  return Global.Path.data
}

/**
 * Normalize and validate a candidate auto-memory directory path.
 *
 * SECURITY: Rejects paths that would be dangerous as a read-allowlist root
 * or that normalize() doesn't fully resolve:
 * - relative (!isAbsolute): "../foo" — would be interpreted relative to CWD
 * - root/near-root (length < 3): "/" → "" after strip; "/a" too short
 * - Windows drive-root (C: regex): "C:\\" → "C:" after strip
 * - UNC paths (\\\\server\\share): network paths — opaque trust boundary
 * - null byte: survives normalize(), can truncate in syscalls
 *
 * Returns the normalized path with exactly one trailing separator,
 * or undefined if the path is unset/empty/rejected.
 */
function validateMemoryPath(raw: string | undefined, expandTilde: boolean): string | undefined {
  if (!raw) return undefined
  let candidate = raw
  if (expandTilde && (candidate.startsWith("~/") || candidate.startsWith("~\\"))) {
    const rest = candidate.slice(2)
    const restNorm = normalize(rest || ".")
    if (restNorm === "." || restNorm === "..") return undefined
    candidate = join(homedir(), rest)
  }
  const normalized = normalize(candidate).replace(/[/\\]+$/, "")
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith("\\\\") ||
    normalized.startsWith("//") ||
    normalized.includes("\0")
  ) {
    return undefined
  }
  return (normalized + sep).normalize("NFC")
}

/**
 * Direct override for the full auto-memory directory path via env var.
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(process.env.ABOOCODE_MEMORY_PATH_OVERRIDE, false)
}

/**
 * Settings override for the full auto-memory directory path.
 * Read from config.memory.directory if set.
 */
async function getAutoMemPathSetting(): Promise<string | undefined> {
  try {
    const config = await Config.get()
    // memory.directory is additive; older config schemas may not include it
    const dir = (config.memory as Record<string, unknown> | undefined)?.directory as string | undefined
    return validateMemoryPath(dir, true)
  } catch {
    return undefined
  }
}

/**
 * Signal that a caller has explicitly opted into auto-memory mechanics via
 * env override — used by write carve-outs.
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * Compute the project-scoped auto-memory directory.
 *
 * Resolution order:
 *   1. ABOOCODE_MEMORY_PATH_OVERRIDE env var
 *   2. config.memory.directory (validated)
 *   3. <baseDir>/memory/<projectID>/   (aboocode-native — project key is
 *      already canonical and stable across worktrees via VCS-based hashing)
 */
export async function getAutoMemPath(): Promise<string> {
  const override = getAutoMemPathOverride() ?? (await getAutoMemPathSetting())
  if (override) return override
  const base = getMemoryBaseDir()
  const projectID = Instance.project.id
  return (path.join(base, AUTO_MEM_DIRNAME, projectID) + sep).normalize("NFC")
}

/**
 * Synchronous variant used by path-containment checks (isAutoMemPath).
 * Skips the config.memory.directory lookup.
 */
export function getAutoMemPathSync(): string {
  const override = getAutoMemPathOverride()
  if (override) return override
  const base = getMemoryBaseDir()
  const projectID = Instance.project.id
  return (path.join(base, AUTO_MEM_DIRNAME, projectID) + sep).normalize("NFC")
}

/**
 * Daily log file path (used by the background observer):
 *   <autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 */
export async function getAutoMemDailyLogPath(date: Date = new Date()): Promise<string> {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, "0")
  const dd = date.getDate().toString().padStart(2, "0")
  return path.join(await getAutoMemPath(), "logs", yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * Auto-memory entrypoint: MEMORY.md inside the auto-memory dir.
 */
export async function getAutoMemEntrypoint(): Promise<string> {
  return path.join(await getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * Check if an absolute path is within the auto-memory directory.
 * SECURITY: Normalizes to prevent `..` bypasses.
 */
export function isAutoMemPath(absolutePath: string): boolean {
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPathSync())
}

/**
 * Ensure the auto-memory directory exists. Safe to call repeatedly.
 */
export async function ensureAutoMemDir(): Promise<string> {
  const { mkdir } = await import("fs/promises")
  const dir = await getAutoMemPath()
  try {
    await mkdir(dir, { recursive: true })
  } catch (e) {
    log.error("ensureAutoMemDir failed", { dir, error: e })
  }
  return dir
}

/** Test helper — returns whether the auto-mem dir exists without creating it. */
export async function autoMemDirExists(): Promise<boolean> {
  return existsSync(await getAutoMemPath())
}
