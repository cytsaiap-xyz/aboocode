import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { Log } from "@/util/log"
import type { MessageV2 } from "./message-v2"

/**
 * Phase 2: Transcript Persistence
 *
 * Saves full conversation history to disk before compaction summarization.
 * This ensures no information is ever permanently lost when context is compressed.
 */
export namespace Transcript {
  const log = Log.create({ service: "session.transcript" })

  function transcriptDir(sessionID: string): string {
    return path.join(Global.Path.data, "transcripts", sessionID)
  }

  /**
   * Save the full message history to a JSONL file before compaction.
   */
  export async function save(input: { sessionID: string; messages: MessageV2.WithParts[] }): Promise<string> {
    const dir = transcriptDir(input.sessionID)
    await fs.mkdir(dir, { recursive: true })

    const timestamp = Date.now()
    const filepath = path.join(dir, `${timestamp}.jsonl`)

    const lines = input.messages.map((msg) =>
      JSON.stringify({
        info: msg.info,
        parts: msg.parts,
      }),
    )

    await fs.writeFile(filepath, lines.join("\n") + "\n", "utf-8")
    log.info("saved transcript", { sessionID: input.sessionID, path: filepath, messages: input.messages.length })
    return filepath
  }

  /**
   * Load a transcript from a JSONL file.
   */
  export async function load(filepath: string): Promise<MessageV2.WithParts[]> {
    const content = await fs.readFile(filepath, "utf-8")
    return content
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as MessageV2.WithParts)
  }

  /**
   * List all saved transcripts for a session, sorted by timestamp (newest first).
   */
  export async function list(sessionID: string): Promise<string[]> {
    const dir = transcriptDir(sessionID)
    try {
      const files = await fs.readdir(dir)
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse()
        .map((f) => path.join(dir, f))
    } catch {
      return []
    }
  }
}
