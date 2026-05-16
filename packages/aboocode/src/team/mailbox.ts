/**
 * Per-agent mailbox backed by a JSONL file under
 * `$XDG_DATA/aboocode/teams/{teamId}/inboxes/{agentId}.jsonl`.
 *
 * Concurrency model: append-only JSONL with an O_EXCL advisory lock per
 * inbox. Readers block until the writer releases the lock; both retry
 * with exponential backoff. Atomic for cross-process writers because
 * file creation with O_EXCL fails if the lock already exists.
 *
 * Why JSONL and not JSON: append is O(1) and we never have to rewrite
 * the whole inbox just to add one message. Mark-read mutates the file
 * but is rare compared to append.
 *
 * Each line is one TeamMessage (see ./messages.ts).
 */

import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { TeamMessage } from "./messages"

const log = Log.create({ service: "team.mailbox" })

const LOCK_RETRY_MS = 5
const LOCK_MAX_RETRY_MS = 100
const LOCK_MAX_RETRIES = 30

function teamRoot(teamId: string): string {
  // teamId is typically the orchestrator session id; sanitize so it can't
  // escape the teams directory via "../" or similar.
  const safe = teamId.replace(/[^a-zA-Z0-9_\-.]/g, "_")
  return path.join(Global.Path.data, "teams", safe)
}

function inboxPath(teamId: string, agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9_\-.]/g, "_")
  return path.join(teamRoot(teamId), "inboxes", `${safe}.jsonl`)
}

function lockPath(file: string): string {
  return file + ".lock"
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  const lockFile = lockPath(file)
  // Ensure the parent dir exists so the lock can be created on the first
  // call into a fresh team directory. Cheap: mkdir -p is idempotent.
  await fs.mkdir(path.dirname(lockFile), { recursive: true })
  let waitMs = LOCK_RETRY_MS
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      // O_EXCL: succeed only if the file does not yet exist.
      const handle = await fs.open(lockFile, "wx")
      await handle.write(`${process.pid}@${Date.now()}`)
      await handle.close()
      return async () => {
        try {
          await fs.unlink(lockFile)
        } catch {
          /* ignore unlink races */
        }
      }
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e
      // Stale lock detection: if the lock file is older than 30s, steal it.
      try {
        const st = await fs.stat(lockFile)
        if (Date.now() - st.mtimeMs > 30_000) {
          log.warn("stealing stale mailbox lock", { lockFile, ageMs: Date.now() - st.mtimeMs })
          await fs.unlink(lockFile).catch(() => {})
          continue
        }
      } catch {
        /* lock vanished between EEXIST and stat — retry */
      }
      await new Promise((r) => setTimeout(r, waitMs))
      waitMs = Math.min(waitMs * 2, LOCK_MAX_RETRY_MS)
    }
  }
  throw new Error(`mailbox: could not acquire lock for ${file} after ${LOCK_MAX_RETRIES} attempts`)
}

async function ensureDir(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
}

async function readLines(file: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(file, "utf-8")
    return raw.split("\n").filter((l) => l.length > 0)
  } catch (e: any) {
    if (e?.code === "ENOENT") return []
    throw e
  }
}

async function writeLines(file: string, lines: string[]): Promise<void> {
  await ensureDir(file)
  const tmp = file + ".tmp"
  await fs.writeFile(tmp, lines.length === 0 ? "" : lines.join("\n") + "\n", "utf-8")
  await fs.rename(tmp, file)
}

export namespace Mailbox {
  /**
   * Append a message to a recipient's inbox. If `to` is "*", broadcast to
   * every member of the team (i.e., every existing inbox under the team
   * directory). Returns the list of inboxes actually written to.
   */
  export async function send(input: { teamId: string; message: TeamMessage }): Promise<string[]> {
    const recipients = input.message.to === "*" ? await listTeammates(input.teamId) : [input.message.to]
    const written: string[] = []
    for (const rcpt of recipients) {
      // Per-recipient envelope: clone with concrete `to`.
      const envelope: TeamMessage = { ...input.message, to: rcpt, read: false, ts: Date.now() }
      const file = inboxPath(input.teamId, rcpt)
      const release = await acquireLock(file)
      try {
        await ensureDir(file)
        await fs.appendFile(file, JSON.stringify(envelope) + "\n", "utf-8")
        written.push(rcpt)
      } finally {
        await release()
      }
    }
    log.info("mailbox send", {
      teamId: input.teamId,
      from: input.message.from,
      to: input.message.to,
      delivered: written.length,
      broadcast: input.message.to === "*",
    })
    return written
  }

  /**
   * Read every message in the inbox. The `read` flag on each message
   * indicates whether the recipient has acknowledged it.
   */
  export async function read(input: { teamId: string; agentId: string }): Promise<TeamMessage[]> {
    const file = inboxPath(input.teamId, input.agentId)
    const lines = await readLines(file)
    const out: TeamMessage[] = []
    for (const line of lines) {
      try {
        out.push(TeamMessage.parse(JSON.parse(line)))
      } catch (e) {
        log.warn("malformed mailbox line, skipping", { file, error: e })
      }
    }
    return out
  }

  /**
   * Read only unread messages and (atomically) mark them read.
   * Used by the auto-inject pre-turn helper so each unread message is
   * surfaced exactly once.
   */
  export async function takeUnread(input: { teamId: string; agentId: string }): Promise<TeamMessage[]> {
    const file = inboxPath(input.teamId, input.agentId)
    const release = await acquireLock(file)
    try {
      const lines = await readLines(file)
      if (lines.length === 0) return []
      const parsed: TeamMessage[] = []
      const rewritten: string[] = []
      const newlyTaken: TeamMessage[] = []
      for (const line of lines) {
        try {
          const msg = TeamMessage.parse(JSON.parse(line))
          if (!msg.read) {
            newlyTaken.push(msg)
            rewritten.push(JSON.stringify({ ...msg, read: true }))
          } else {
            rewritten.push(line)
          }
          parsed.push(msg)
        } catch {
          rewritten.push(line)
        }
      }
      if (newlyTaken.length > 0) {
        await writeLines(file, rewritten)
        log.info("mailbox takeUnread", {
          teamId: input.teamId,
          agentId: input.agentId,
          taken: newlyTaken.length,
          total: parsed.length,
        })
      }
      return newlyTaken
    } finally {
      await release()
    }
  }

  /** Remove all messages from a recipient's inbox. */
  export async function clear(input: { teamId: string; agentId: string }): Promise<number> {
    const file = inboxPath(input.teamId, input.agentId)
    const release = await acquireLock(file)
    try {
      const lines = await readLines(file)
      if (lines.length === 0) return 0
      await writeLines(file, [])
      log.info("mailbox clear", {
        teamId: input.teamId,
        agentId: input.agentId,
        cleared: lines.length,
      })
      return lines.length
    } finally {
      await release()
    }
  }

  /** List every agent that has an inbox under the team. */
  export async function listTeammates(teamId: string): Promise<string[]> {
    const dir = path.join(teamRoot(teamId), "inboxes")
    try {
      const entries = await fs.readdir(dir)
      return entries.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length))
    } catch (e: any) {
      if (e?.code === "ENOENT") return []
      throw e
    }
  }

  /**
   * Initialize an inbox file (touch). Useful so broadcast (`to:"*"`)
   * reliably reaches a teammate that hasn't received any direct
   * messages yet.
   */
  export async function ensureInbox(teamId: string, agentId: string): Promise<void> {
    const file = inboxPath(teamId, agentId)
    await ensureDir(file)
    try {
      await fs.access(file)
    } catch {
      await fs.writeFile(file, "", "utf-8")
    }
  }

  /** Test helper — wipe a team directory entirely. */
  export async function _resetForTests(teamId: string): Promise<void> {
    await fs.rm(teamRoot(teamId), { recursive: true, force: true })
  }
}
