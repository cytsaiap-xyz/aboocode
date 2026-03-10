import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"
import { SessionStatus } from "@/session/status"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MarkdownStore } from "./markdown-store"
import { Config } from "@/config/config"
import { UsageLog } from "@/usage-log"
import { DebugLog } from "@/debug-log"

const log = Log.create({ service: "memory.observer" })

/**
 * Background observer that watches the conversation between user and AI agent
 * in real-time, like a meeting recorder. Produces structured session notes
 * organized by topic (architecture, debug, problem-solving, style, etc.)
 */
export namespace Observer {
  // --- Per-session buffer ---
  interface SessionBuffer {
    sessionID: string
    messages: BufferedMessage[]
    lastFlushAt: number
    flushCount: number
    pendingFlush: boolean
  }

  interface BufferedMessage {
    role: "user" | "assistant"
    text: string
    tools: string[]
    time: number
  }

  const buffers = new Map<string, SessionBuffer>()

  // Flush every N messages or on session idle
  const FLUSH_THRESHOLD = 2
  // Minimum chars of conversation before flushing
  const MIN_CONTENT_LENGTH = 50
  // Debounce: don't flush more than once per 10s
  const FLUSH_COOLDOWN_MS = 10_000

  let initialized = false

  export function init(): void {
    if (initialized) return
    initialized = true
    UsageLog.record("memory.observer", "init")
    DebugLog.section("OBSERVER INIT")

    // Watch completed messages (not deltas — we want full messages)
    Bus.subscribe(MessageV2.Event.Updated, (event) => {
      const info = event.properties.info
      if (!info) return

      const sessionID = "sessionID" in info ? (info as any).sessionID : undefined
      if (!sessionID) return

      // Collect the message into the buffer
      collectMessage(sessionID, info)
    })

    // Flush on session idle (final sweep)
    Bus.subscribe(SessionStatus.Event.Status, async (event) => {
      if (event.properties.status.type !== "idle") return
      const sessionID = event.properties.sessionID
      const buffer = buffers.get(sessionID)
      if (!buffer || buffer.messages.length === 0) return

      await flush(buffer, "idle")
    })

    log.info("observer initialized — watching messages")
  }

  function collectMessage(
    sessionID: string,
    info: any,
  ): void {
    let buffer = buffers.get(sessionID)
    if (!buffer) {
      buffer = {
        sessionID,
        messages: [],
        lastFlushAt: 0,
        flushCount: 0,
        pendingFlush: false,
      }
      buffers.set(sessionID, buffer)
    }

    // Extract text and tools from the message info
    // MessageV2.Event.Updated sends the info, but parts come separately
    // We'll use a simplified approach: track role + any available text
    const role = info.role as "user" | "assistant" | undefined
    if (!role || (role !== "user" && role !== "assistant")) return

    const msg: BufferedMessage = {
      role,
      text: "",
      tools: [],
      time: Date.now(),
    }

    buffer.messages.push(msg)

    // Check if we should flush
    if (
      buffer.messages.length >= FLUSH_THRESHOLD &&
      !buffer.pendingFlush &&
      Date.now() - buffer.lastFlushAt > FLUSH_COOLDOWN_MS
    ) {
      buffer.pendingFlush = true
      // Fire and forget — don't block the main agent
      flush(buffer, "threshold").catch((e) => {
        log.error("observer flush failed", { error: e })
      })
    }
  }

  /**
   * Collect full message content from the session store.
   * Called before flush to get actual text content.
   */
  async function collectFullMessages(sessionID: string): Promise<BufferedMessage[]> {
    const messages: BufferedMessage[] = []
    try {
      for await (const msg of MessageV2.stream(sessionID)) {
        const role = msg.info.role as "user" | "assistant"
        if (role !== "user" && role !== "assistant") continue

        const textParts = msg.parts
          .filter((p): p is MessageV2.TextPart => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n")

        const tools = msg.parts
          .filter((p): p is MessageV2.ToolPart => p.type === "tool")
          .map((p) => {
            const tool = p as MessageV2.ToolPart
            const state = tool.state
            const input = "input" in state ? JSON.stringify((state as any).input).slice(0, 200) : ""
            return `${tool.tool}(${input})`
          })

        if (textParts || tools.length > 0) {
          messages.push({
            role,
            text: textParts.slice(0, 800),
            tools,
            time: msg.info.time.created,
          })
        }
      }
    } catch (e) {
      log.error("failed to collect full messages", { error: e })
    }
    return messages
  }

  async function flush(buffer: SessionBuffer, trigger: "threshold" | "idle"): Promise<void> {
    const sessionID = buffer.sessionID
    UsageLog.record("memory.observer", "flush", { trigger, sessionID, messageCount: buffer.messages.length })
    DebugLog.section(`OBSERVER FLUSH [${trigger}]`)

    try {
      // Get full message content from session store
      const fullMessages = await collectFullMessages(sessionID)

      if (fullMessages.length < 3) {
        DebugLog.line(`  Skipped: only ${fullMessages.length} messages`)
        return
      }

      // Check for meaningful work (not just reads/searches)
      const hasMeaningfulWork = fullMessages.some((m) =>
        m.tools.some(
          (t) =>
            !t.startsWith("Read(") &&
            !t.startsWith("Glob(") &&
            !t.startsWith("Grep("),
        ),
      )
      if (!hasMeaningfulWork) {
        DebugLog.line(`  Skipped: no meaningful tool usage`)
        return
      }

      // Build conversation transcript for the observer
      const transcript = buildTranscript(fullMessages, buffer.flushCount > 0)

      if (transcript.length < MIN_CONTENT_LENGTH) {
        DebugLog.line(`  Skipped: transcript too short (${transcript.length} chars)`)
        return
      }

      DebugLog.line(`  Messages: ${fullMessages.length}, Transcript: ${transcript.length} chars`)

      // Call LLM in parallel (fire-and-forget, independent of main agent)
      const notes = await callObserverLLM(sessionID, transcript, fullMessages)

      if (!notes || notes.trim().length === 0) {
        DebugLog.line(`  LLM returned empty — nothing notable`)
        return
      }

      // Write to session notes file
      writeSessionNotes(sessionID, notes, trigger)

      buffer.flushCount++
      DebugLog.line(`  Wrote ${notes.trim().length} chars of session notes (flush #${buffer.flushCount})`)
    } catch (e) {
      log.error("observer flush error", { error: e })
    } finally {
      buffer.lastFlushAt = Date.now()
      buffer.pendingFlush = false
      // Clear the buffer after flush
      buffer.messages = []
    }
  }

  function buildTranscript(messages: BufferedMessage[], isFollowUp: boolean): string {
    const lines: string[] = []

    if (isFollowUp) {
      lines.push("[This is a continuation of the session — only note NEW observations]\n")
    }

    for (const msg of messages) {
      const time = new Date(msg.time).toLocaleTimeString("en-US", { hour12: false })

      if (msg.role === "user") {
        lines.push(`[${time}] USER: ${msg.text}`)
      } else {
        if (msg.text) {
          lines.push(`[${time}] AGENT: ${msg.text}`)
        }
        if (msg.tools.length > 0) {
          lines.push(`  Tools: ${msg.tools.join(", ")}`)
        }
      }
    }

    return lines.join("\n")
  }

  async function callObserverLLM(
    sessionID: string,
    transcript: string,
    messages: BufferedMessage[],
  ): Promise<string | null> {
    try {
      const agent = await Agent.get("session-observer")
      if (!agent) {
        log.warn("session-observer agent not found")
        return null
      }

      const config = await Config.get()
      const defaultModel = await Provider.defaultModel()
      const model =
        (await Provider.getSmallModel(defaultModel.providerID)) ??
        (await Provider.getModel(defaultModel.providerID, defaultModel.modelID))

      // Read existing session notes for context (avoid repetition)
      const existingNotes = readSessionNotes(sessionID)
      const existingContext = existingNotes
        ? `\n\nExisting session notes (DO NOT repeat these):\n${existingNotes}\n\n`
        : ""

      const lastUserMsg = messages.findLast((m) => m.role === "user")
      if (!lastUserMsg) return null

      const prompt = `${existingContext}Session transcript:\n${transcript}`

      DebugLog.line(`  Calling observer LLM (${defaultModel.providerID}/${defaultModel.modelID})...`)

      const result = await LLM.stream({
        agent,
        user: { role: "user", time: { created: lastUserMsg.time } } as any,
        sessionID,
        model,
        system: [],
        small: true,
        tools: {},
        abort: new AbortController().signal,
        retries: 1,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      })

      const text = await result.text.catch((err) => {
        log.error("observer LLM call failed", { error: err })
        return null
      })

      return text
    } catch (e) {
      log.error("observer LLM error", { error: e })
      return null
    }
  }

  // --- Session notes file management ---

  function getSessionNotesPath(sessionID: string): string {
    const dir = MarkdownStore.getDir()
    return path.join(dir, "sessions", `${sessionID.slice(0, 8)}.md`)
  }

  function readSessionNotes(sessionID: string): string {
    const filePath = getSessionNotesPath(sessionID)
    try {
      if (!existsSync(filePath)) return ""
      return readFileSync(filePath, "utf-8")
    } catch {
      return ""
    }
  }

  function writeSessionNotes(sessionID: string, notes: string, trigger: string): void {
    const filePath = getSessionNotesPath(sessionID)
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const timestamp = new Date().toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })

    const header = existsSync(filePath)
      ? `\n\n---\n_Updated: ${timestamp}_\n\n`
      : `# Session Notes\n_Started: ${timestamp}_\n\n`

    const content = existsSync(filePath)
      ? readFileSync(filePath, "utf-8") + header + notes.trim() + "\n"
      : header + notes.trim() + "\n"

    writeFileSync(filePath, content, "utf-8")

    UsageLog.record("memory.observer", "writeSessionNotes", {
      sessionID: sessionID.slice(0, 8),
      contentLength: content.length,
      trigger,
    })
    DebugLog.memoryStoreWrite(filePath, content.length)
  }

  /**
   * Merge session notes into MEMORY.md on session end.
   * Called after final flush to consolidate important findings.
   */
  export async function mergeToMemory(sessionID: string): Promise<void> {
    const notes = readSessionNotes(sessionID)
    if (!notes || notes.length < 100) return

    UsageLog.record("memory.observer", "mergeToMemory", { sessionID: sessionID.slice(0, 8) })

    try {
      const agent = await Agent.get("memory-extractor")
      if (!agent) return

      const defaultModel = await Provider.defaultModel()
      const model =
        (await Provider.getSmallModel(defaultModel.providerID)) ??
        (await Provider.getModel(defaultModel.providerID, defaultModel.modelID))

      const existingMemory = MarkdownStore.readMemory()
      const prompt = `${existingMemory ? `Current MEMORY.md:\n${existingMemory}\n\n` : ""}Session notes to consolidate:\n${notes}\n\nExtract only the most important, long-lasting insights to add to MEMORY.md. Skip session-specific details.`

      const result = await LLM.stream({
        agent,
        user: { role: "user", time: { created: Date.now() } } as any,
        sessionID,
        model,
        system: [],
        small: true,
        tools: {},
        abort: new AbortController().signal,
        retries: 1,
        messages: [{ role: "user", content: prompt }],
      })

      const text = await result.text.catch(() => null)
      if (!text || text.trim().length === 0) return

      const existing = MarkdownStore.readMemory()
      const updated = existing
        ? existing.trimEnd() + "\n\n" + text.trim() + "\n"
        : text.trim() + "\n"
      MarkdownStore.writeMemory(updated)
      DebugLog.line(`  Merged session notes to MEMORY.md (${text.trim().length} chars)`)
    } catch (e) {
      log.error("merge to memory failed", { error: e })
    }
  }

  export function cleanup(sessionID: string): void {
    buffers.delete(sessionID)
  }
}
