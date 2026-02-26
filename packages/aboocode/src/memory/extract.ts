import { Log } from "@/util/log"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { Instance } from "@/project/instance"
import { Config } from "@/config/config"
import { Memory } from "./index"
import type { MemoryTypes } from "./types"

const log = Log.create({ service: "memory.extract" })

// Track which sessions have been extracted to avoid duplicate work
const extractedSessions = new Map<string, number>()

export async function extractMemories(sessionID: string): Promise<void> {
  const lastExtracted = extractedSessions.get(sessionID) ?? 0
  const config = await Config.get()

  // Collect messages from the session
  const messages: MessageV2.WithParts[] = []
  for await (const msg of MessageV2.stream(sessionID)) {
    messages.push(msg)
  }

  if (messages.length === 0) return

  // Filter to messages since last extraction
  const newMessages = messages.filter((m) => m.info.time.created > lastExtracted)
  if (newMessages.length < 3) return

  // Check if there were meaningful actions (not just reads)
  const hasMeaningfulAction = newMessages.some((m) =>
    m.parts.some(
      (p) =>
        p.type === "tool" &&
        (p as MessageV2.ToolPart).tool !== "Read" &&
        (p as MessageV2.ToolPart).tool !== "Glob" &&
        (p as MessageV2.ToolPart).tool !== "Grep",
    ),
  )
  if (!hasMeaningfulAction) return

  // Build conversation summary for LLM
  const summary = buildConversationSummary(newMessages)
  if (summary.length < 100) return

  try {
    const agent = await Agent.get("memory-extractor")
    if (!agent) {
      log.warn("memory-extractor agent not found")
      return
    }

    // Get model - prefer small model for cost efficiency
    const primaryModel = config.model
    if (!primaryModel) {
      log.warn("no model configured, skipping extraction")
      return
    }

    const parsed = Provider.parseModel(primaryModel)
    const model =
      (await Provider.getSmallModel(parsed.providerID)) ??
      (await Provider.getModel(parsed.providerID, parsed.modelID))

    // Find the last user message to use as reference
    const lastUserMsg = messages.findLast((m) => m.info.role === "user")
    if (!lastUserMsg) return
    const userInfo = lastUserMsg.info as MessageV2.User

    const result = await LLM.stream({
      agent,
      user: userInfo,
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
          content: summary,
        },
      ],
    })

    const text = await result.text.catch((err) => {
      log.error("extraction LLM call failed", { error: err })
      return null
    })

    if (!text) return

    // Parse extracted memories from LLM response
    const extracted = parseExtractedMemories(text)
    if (extracted.length === 0) return

    // Store each extracted memory
    let stored = 0
    for (const mem of extracted) {
      try {
        await Memory.add({
          title: mem.title,
          content: mem.content,
          type: mem.type,
          category: mem.category,
          tags: mem.tags,
          sessionID,
        })
        stored++
      } catch (e) {
        // Likely duplicate or limit reached
        log.debug("skipped memory", { title: mem.title, error: e })
      }
    }

    extractedSessions.set(sessionID, Date.now())
    log.info("extracted memories", { sessionID, extracted: extracted.length, stored })
  } catch (e) {
    log.error("memory extraction failed", { error: e })
  }
}

function buildConversationSummary(messages: MessageV2.WithParts[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.info.role === "user") {
      const textParts = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
      if (textParts) lines.push(`User: ${textParts.slice(0, 500)}`)
    } else if (msg.info.role === "assistant") {
      const textParts = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
      if (textParts) lines.push(`Assistant: ${textParts.slice(0, 500)}`)

      // Note tool usage
      const tools = msg.parts
        .filter((p): p is MessageV2.ToolPart => p.type === "tool")
        .map((p) => p.tool)
      if (tools.length > 0) lines.push(`Tools used: ${tools.join(", ")}`)
    }
  }

  return lines.join("\n")
}

function parseExtractedMemories(text: string): MemoryTypes.ExtractedMemory[] {
  try {
    // Try to parse as JSON array
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (item: any) =>
              item &&
              typeof item.title === "string" &&
              typeof item.content === "string" &&
              typeof item.type === "string",
          )
          .map((item: any) => ({
            type: validateType(item.type),
            category: validateCategory(item.category),
            title: item.title.slice(0, 200),
            content: item.content.slice(0, 1000),
            tags: Array.isArray(item.tags) ? item.tags.filter((t: any) => typeof t === "string").slice(0, 10) : [],
          }))
      }
    }
  } catch {
    log.debug("failed to parse extraction result as JSON")
  }
  return []
}

function validateType(type: string): MemoryTypes.MemoryType {
  const valid: MemoryTypes.MemoryType[] = ["decision", "pattern", "bugfix", "lesson", "feature", "note"]
  return valid.includes(type as any) ? (type as MemoryTypes.MemoryType) : "note"
}

function validateCategory(category: string): MemoryTypes.MemoryCategory {
  const valid: MemoryTypes.MemoryCategory[] = ["solution", "knowledge"]
  return valid.includes(category as any) ? (category as MemoryTypes.MemoryCategory) : "knowledge"
}
