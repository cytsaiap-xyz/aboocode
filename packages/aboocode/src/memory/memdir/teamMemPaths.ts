/**
 * Team memory path validation.
 *
 * Ported from claude-code-leak/src/memdir/teamMemPaths.ts.
 *
 * Team memory is a sub-directory of the private auto-memory dir:
 *   <autoMemDir>/team/
 *
 * Path helpers here are the choke point for any write that targets team
 * memory: they reject traversal attempts (string-level), resolve symlinks
 * on the deepest existing ancestor, and verify the real path is still
 * within the real team dir. Callers MUST await the validate* helpers
 * before writing.
 */

import { lstat, realpath } from "fs/promises"
import { dirname, join, resolve, sep } from "path"
import { Config } from "@/config/config"
import { getAutoMemPath, isAutoMemoryEnabled } from "./paths"

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathTraversalError"
  }
}

/**
 * Reject dangerous patterns in a relative key: null bytes, URL-encoded
 * traversals, NFKC-normalized traversals (fullwidth ．．／ → ../), and
 * absolute/backslash paths.
 */
function sanitizePathKey(key: string): string {
  if (key.includes("\0")) {
    throw new PathTraversalError(`Null byte in path key: "${key}"`)
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(key)
  } catch {
    decoded = key
  }
  if (decoded !== key && (decoded.includes("..") || decoded.includes("/"))) {
    throw new PathTraversalError(`URL-encoded traversal in path key: "${key}"`)
  }
  const normalized = key.normalize("NFKC")
  if (
    normalized !== key &&
    (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0"))
  ) {
    throw new PathTraversalError(`Unicode-normalized traversal in path key: "${key}"`)
  }
  if (key.includes("\\")) {
    throw new PathTraversalError(`Backslash in path key: "${key}"`)
  }
  if (key.startsWith("/")) {
    throw new PathTraversalError(`Absolute path key: "${key}"`)
  }
  return key
}

/**
 * Team memory requires auto memory + an explicit opt-in via config.
 * Default OFF — teams that want shared memory set config.memory.team=true.
 */
export async function isTeamMemoryEnabled(): Promise<boolean> {
  if (!(await isAutoMemoryEnabled())) return false
  try {
    const config = await Config.get()
    // config.memory.team is additive
    return (config.memory as Record<string, unknown> | undefined)?.team === true
  } catch {
    return false
  }
}

/**
 * Team memory path: <autoMemDir>/team/
 */
export async function getTeamMemPath(): Promise<string> {
  return (join(await getAutoMemPath(), "team") + sep).normalize("NFC")
}

export async function getTeamMemEntrypoint(): Promise<string> {
  return join(await getAutoMemPath(), "team", "MEMORY.md")
}

function errnoCode(e: unknown): string | undefined {
  if (e instanceof Error && "code" in e && typeof (e as { code?: string }).code === "string") {
    return (e as { code: string }).code
  }
  return undefined
}

/**
 * Resolve symlinks on the deepest existing ancestor of a path. The target
 * file may not exist yet (we may be about to create it), so walk up until
 * realpath() succeeds, then rejoin the non-existing tail onto the resolved
 * ancestor.
 */
async function realpathDeepestExisting(absolutePath: string): Promise<string> {
  const tail: string[] = []
  let current = absolutePath
  for (let parent = dirname(current); current !== parent; parent = dirname(current)) {
    try {
      const realCurrent = await realpath(current)
      return tail.length === 0 ? realCurrent : join(realCurrent, ...tail.reverse())
    } catch (e: unknown) {
      const code = errnoCode(e)
      if (code === "ENOENT") {
        // Dangling symlinks are an attack vector: writeFile would follow the
        // link and create the target outside teamDir. lstat distinguishes
        // dangling symlinks from truly non-existent paths.
        try {
          const st = await lstat(current)
          if (st.isSymbolicLink()) {
            throw new PathTraversalError(`Dangling symlink detected (target does not exist): "${current}"`)
          }
        } catch (lstatErr: unknown) {
          if (lstatErr instanceof PathTraversalError) throw lstatErr
        }
      } else if (code === "ELOOP") {
        throw new PathTraversalError(`Symlink loop detected in path: "${current}"`)
      } else if (code !== "ENOTDIR" && code !== "ENAMETOOLONG") {
        throw new PathTraversalError(`Cannot verify path containment (${code}): "${current}"`)
      }
      tail.push(current.slice(parent.length + sep.length))
      current = parent
    }
  }
  return absolutePath
}

async function isRealPathWithinTeamDir(realCandidate: string): Promise<boolean> {
  let realTeamDir: string
  try {
    realTeamDir = await realpath((await getTeamMemPath()).replace(/[/\\]+$/, ""))
  } catch (e: unknown) {
    const code = errnoCode(e)
    if (code === "ENOENT" || code === "ENOTDIR") return true
    return false
  }
  if (realCandidate === realTeamDir) return true
  return realCandidate.startsWith(realTeamDir + sep)
}

/**
 * Check if a resolved absolute path is within the team memory directory
 * (string-level only — does not resolve symlinks).
 */
export async function isTeamMemPath(filePath: string): Promise<boolean> {
  const resolvedPath = resolve(filePath)
  const teamDir = await getTeamMemPath()
  return resolvedPath.startsWith(teamDir)
}

/**
 * Full validation for an absolute path destined for a team memory write.
 * Returns the resolved path on success, throws PathTraversalError on any
 * traversal or symlink-escape attempt.
 */
export async function validateTeamMemWritePath(filePath: string): Promise<string> {
  if (filePath.includes("\0")) {
    throw new PathTraversalError(`Null byte in path: "${filePath}"`)
  }
  const resolvedPath = resolve(filePath)
  const teamDir = await getTeamMemPath()
  if (!resolvedPath.startsWith(teamDir)) {
    throw new PathTraversalError(`Path escapes team memory directory: "${filePath}"`)
  }
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinTeamDir(realPath))) {
    throw new PathTraversalError(`Path escapes team memory directory via symlink: "${filePath}"`)
  }
  return resolvedPath
}

/**
 * Validate a relative key (e.g. "feedback/testing.md") against the team
 * memory directory. Sanitizes, joins, resolves symlinks, and verifies
 * containment. Returns the resolved absolute path.
 */
export async function validateTeamMemKey(relativeKey: string): Promise<string> {
  sanitizePathKey(relativeKey)
  const teamDir = await getTeamMemPath()
  const fullPath = join(teamDir, relativeKey)
  const resolvedPath = resolve(fullPath)
  if (!resolvedPath.startsWith(teamDir)) {
    throw new PathTraversalError(`Key escapes team memory directory: "${relativeKey}"`)
  }
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinTeamDir(realPath))) {
    throw new PathTraversalError(`Key escapes team memory directory via symlink: "${relativeKey}"`)
  }
  return resolvedPath
}

export async function isTeamMemFile(filePath: string): Promise<boolean> {
  return (await isTeamMemoryEnabled()) && (await isTeamMemPath(filePath))
}
