/**
 * MCP skill builders — wrap MCP prompts as skills.
 *
 * Ported from claude-code-leak's src/skills/mcpSkillBuilders.ts.
 *
 * An MCP server can expose "prompts" (pre-baked templates with arguments)
 * alongside tools and resources. Rather than making the user invoke them
 * through the low-level MCP prompt API, we wrap each prompt as a skill so
 * it shows up in the skill picker and can be invoked with /<name> or via
 * the Skill tool.
 *
 * The wrapper resolves the prompt lazily: the Skill tool asks the MCP
 * client for the prompt body only when the user actually invokes it,
 * which keeps startup fast and avoids holding stale prompt text.
 */

import { Log } from "@/util/log"
import { MCP } from "@/mcp"
import type { Skill as SkillNs } from "./skill"

const log = Log.create({ service: "skill.mcp-builders" })

export type McpSkill = Pick<SkillNs.Info, "name" | "description" | "content" | "location"> & {
  source: "mcp"
  /** Which MCP server owns this prompt. */
  mcpServer: string
  /** The prompt name on that server. */
  mcpPromptName: string
}

/**
 * Fetch all prompts from all connected MCP servers and wrap them as skills.
 *
 * The content field is initially empty — the MCP prompt bodies are fetched
 * lazily on demand to avoid a cold start spending time reading prompts
 * that may not be used. Callers that need the content should call
 * materialize(skill).
 */
export async function buildMcpSkills(): Promise<McpSkill[]> {
  try {
    const prompts = await MCP.prompts()
    const skills: McpSkill[] = []
    for (const [name, info] of Object.entries(prompts)) {
      const prompt = info as { description?: string; client: string; name: string }
      skills.push({
        name: `mcp_${prompt.client}_${prompt.name}`,
        description: prompt.description ?? `MCP prompt from ${prompt.client}`,
        content: "",
        location: `mcp://${prompt.client}/${prompt.name}`,
        source: "mcp",
        mcpServer: prompt.client,
        mcpPromptName: prompt.name,
      })
    }
    return skills
  } catch (e) {
    log.warn("buildMcpSkills failed", { error: e })
    return []
  }
}

/**
 * Materialize a single MCP skill by fetching the prompt body from the
 * upstream server. Pass any required arguments as a Record<string,string>.
 * Returns the rendered prompt text or null on failure.
 */
export async function materialize(skill: McpSkill, args: Record<string, string> = {}): Promise<string | null> {
  try {
    const result = await MCP.getPrompt(skill.mcpServer, skill.mcpPromptName, args)
    if (!result) return null
    // MCP prompt responses are a list of messages. Concatenate them into
    // a single string the Skill tool can inject as a user prompt.
    type PromptMessage = { role: string; content: { type: string; text?: string } | Array<{ type: string; text?: string }> }
    const messages = (result as { messages?: PromptMessage[] }).messages ?? []
    const parts: string[] = []
    for (const msg of messages) {
      const role = msg.role ?? "user"
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push(`**${role}**: ${block.text}`)
        }
      } else if (msg.content?.type === "text" && msg.content.text) {
        parts.push(`**${role}**: ${msg.content.text}`)
      }
    }
    return parts.join("\n\n")
  } catch (e) {
    log.warn("materialize mcp skill failed", {
      server: skill.mcpServer,
      prompt: skill.mcpPromptName,
      error: e,
    })
    return null
  }
}
