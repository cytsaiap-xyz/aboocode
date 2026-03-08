/**
 * Helper script: manually trigger memory extraction for a session.
 *
 * Usage:
 *   bun run --conditions=browser ./test/e2e/extract-memory.ts <sessionID> [workDir]
 *
 * This is needed because Memory.init() only runs in TUI mode,
 * so auto-extraction doesn't trigger in CLI `run` mode.
 *
 * It also patches config.model if unset, since extractMemories requires it
 * but the CLI run path uses Provider.defaultModel() which bypasses config.
 */
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { MarkdownStore } from "@/memory/markdown-store"
import { UsageLog } from "@/usage-log"

const sessionID = process.argv[2]
const workDir = process.argv[3]
if (!sessionID) {
  console.error("Usage: bun run extract-memory.ts <sessionID> [workDir]")
  process.exit(1)
}

const directory = workDir ?? process.cwd()
console.log(`Using directory: ${directory}`)

await Instance.provide({
  directory,
  init: InstanceBootstrap,
  fn: async () => {
    try {
      UsageLog.record("memory", "extractMemories", { sessionID })

      // Collect messages from the session
      const messages: MessageV2.WithParts[] = []
      for await (const msg of MessageV2.stream(sessionID)) {
        messages.push(msg)
      }

      console.log(`Found ${messages.length} messages in session`)

      if (messages.length === 0) {
        console.log("No messages found, skipping extraction")
        return
      }

      // Check for meaningful actions
      const hasMeaningfulAction = messages.some((m) =>
        m.parts.some(
          (p) =>
            p.type === "tool" &&
            (p as MessageV2.ToolPart).tool !== "Read" &&
            (p as MessageV2.ToolPart).tool !== "Glob" &&
            (p as MessageV2.ToolPart).tool !== "Grep",
        ),
      )
      console.log(`Has meaningful actions: ${hasMeaningfulAction}`)

      if (!hasMeaningfulAction) {
        console.log("No meaningful actions found, skipping")
        return
      }

      // Build conversation summary
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
          const tools = msg.parts
            .filter((p): p is MessageV2.ToolPart => p.type === "tool")
            .map((p) => p.tool)
          if (tools.length > 0) lines.push(`Tools used: ${tools.join(", ")}`)
        }
      }
      const summary = lines.join("\n")
      console.log(`Summary length: ${summary.length} chars`)

      if (summary.length < 100) {
        console.log("Summary too short, skipping")
        return
      }

      // Get agent and model
      const agent = await Agent.get("memory-extractor")
      if (!agent) {
        console.error("memory-extractor agent not found")
        return
      }

      const defaultModel = await Provider.defaultModel()
      console.log(`Using model: ${defaultModel.providerID}/${defaultModel.modelID}`)
      const model =
        (await Provider.getSmallModel(defaultModel.providerID)) ??
        (await Provider.getModel(defaultModel.providerID, defaultModel.modelID))

      // Find last user message for reference
      const lastUserMsg = messages.findLast((m) => m.info.role === "user")
      if (!lastUserMsg) return
      const userInfo = lastUserMsg.info as MessageV2.User

      // Read existing memory
      const existingContent = MarkdownStore.readMemory()
      UsageLog.record("memory.markdown-store", "readMemory")

      const prompt = `${existingContent ? `Current MEMORY.md content:\n${existingContent}\n\n` : ""}Conversation summary:\n${summary}`

      console.log("Calling LLM for extraction...")
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
        console.error("LLM call failed:", err)
        return null
      })

      if (!text || text.trim().length === 0) {
        console.log("LLM returned empty result")
        return
      }

      console.log(`Extracted ${text.trim().length} chars of memory`)
      console.log("--- Extracted content ---")
      console.log(text.trim())
      console.log("--- End ---")

      // Write to MEMORY.md
      const existing = MarkdownStore.readMemory()
      const updated = existing ? existing.trimEnd() + "\n\n" + text.trim() + "\n" : text.trim() + "\n"
      MarkdownStore.writeMemory(updated)
      UsageLog.record("memory.markdown-store", "writeMemory", { contentLength: updated.length })

      console.log("Memory extraction complete — written to MEMORY.md")
    } catch (e) {
      console.error("Extraction failed:", e)
      process.exit(1)
    } finally {
      await Instance.dispose()
    }
  },
})
