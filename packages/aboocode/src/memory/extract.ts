import { Log } from "@/util/log"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { Config } from "@/config/config"
import { MarkdownStore } from "./markdown-store"
import { UsageLog } from "@/usage-log"
import { DebugLog } from "@/debug-log"

const log = Log.create({ service: "memory.extract" })

// Track which sessions have been extracted to avoid duplicate work
const extractedSessions = new Map<string, number>()

export async function extractMemories(sessionID: string): Promise<void> {
  UsageLog.record("memory", "extractMemories", { sessionID })
  const lastExtracted = extractedSessions.get(sessionID) ?? 0
  const config = await Config.get()

  // Collect messages from the session
  const messages: MessageV2.WithParts[] = []
  for await (const msg of MessageV2.stream(sessionID)) {
    messages.push(msg)
  }

  if (messages.length === 0) {
    DebugLog.memoryExtractSkipped(sessionID, "no messages")
    return
  }

  // Filter to messages since last extraction
  const newMessages = messages.filter((m) => m.info.time.created > lastExtracted)
  if (newMessages.length < 3) {
    DebugLog.memoryExtractSkipped(sessionID, `only ${newMessages.length} new messages (need >=3)`)
    return
  }

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
  if (!hasMeaningfulAction) {
    DebugLog.memoryExtractSkipped(sessionID, "no meaningful actions (only read/glob/grep)")
    return
  }

  DebugLog.memoryExtractStart(sessionID, newMessages.length)

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

    // Read existing MEMORY.md content for context
    const existingContent = MarkdownStore.readMemory()

    const prompt = `${existingContent ? `Current MEMORY.md content:\n${existingContent}\n\n` : ""}Conversation summary:\n${summary}`

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
          content: prompt,
        },
      ],
    })

    const text = await result.text.catch((err) => {
      log.error("extraction LLM call failed", { error: err })
      return null
    })

    if (!text || text.trim().length === 0) {
      DebugLog.memoryExtractSkipped(sessionID, "LLM returned empty text")
      return
    }

    // Append the extracted notes to MEMORY.md
    const existing = MarkdownStore.readMemory()
    const updated = existing ? existing.trimEnd() + "\n\n" + text.trim() + "\n" : text.trim() + "\n"
    MarkdownStore.writeMemory(updated)

    extractedSessions.set(sessionID, Date.now())
    DebugLog.memoryExtractDone(sessionID, text.trim().length, text.trim())
    log.info("extracted memories to MEMORY.md", { sessionID })
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
