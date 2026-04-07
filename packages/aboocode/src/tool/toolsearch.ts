import z from "zod"
import { Tool } from "./tool"
import { Log } from "@/util/log"

/**
 * Phase 7: Deferred Tool Loading (ToolSearch)
 *
 * When total tool count exceeds a threshold, MCP and custom tools are
 * deferred — only their names appear in the system prompt. The model
 * uses this tool to fetch full schemas on demand.
 */
export namespace ToolSearch {
  const log = Log.create({ service: "tool.toolsearch" })

  export const DEFER_THRESHOLD = 15

  export interface DeferredToolInfo {
    id: string
    description: string
    parameters: any
    execute: any
  }

  const sessionToolCache = new Map<string, Map<string, DeferredToolInfo>>()

  export function getActivatedTools(sessionID: string): Map<string, DeferredToolInfo> {
    if (!sessionToolCache.has(sessionID)) {
      sessionToolCache.set(sessionID, new Map())
    }
    return sessionToolCache.get(sessionID)!
  }

  export function activateTool(sessionID: string, tool: DeferredToolInfo) {
    const cache = getActivatedTools(sessionID)
    cache.set(tool.id, tool)
    log.info("activated", { sessionID, tool: tool.id })
  }

  export function clearSession(sessionID: string) {
    sessionToolCache.delete(sessionID)
  }

  /**
   * Search deferred tools by keyword query.
   * Supports "select:name1,name2" for exact matches or keyword search.
   */
  export function search(
    query: string,
    deferred: DeferredToolInfo[],
    maxResults: number = 5,
  ): DeferredToolInfo[] {
    if (query.startsWith("select:")) {
      const names = query
        .slice(7)
        .split(",")
        .map((n) => n.trim().toLowerCase())
      return deferred.filter((t) => names.includes(t.id.toLowerCase()))
    }

    const terms = query.toLowerCase().split(/\s+/)
    const scored = deferred.map((tool) => {
      const text = `${tool.id} ${tool.description}`.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (tool.id.toLowerCase().includes(term)) score += 3
        if (text.includes(term)) score += 1
      }
      return { tool, score }
    })

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.tool)
  }
}

/**
 * ToolSearchTool — allows the model to fetch deferred tool schemas.
 */
export const ToolSearchTool = Tool.define<
  z.ZodObject<{
    query: z.ZodString
    max_results: z.ZodOptional<z.ZodNumber>
  }>,
  {}
>("toolsearch", {
  description:
    'Search for and load deferred tool schemas. Use "select:name1,name2" for exact matches, or keywords to search. Returns full tool definitions that become available for use.',
  parameters: z.object({
    query: z
      .string()
      .describe('Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.'),
    max_results: z.number().optional().describe("Maximum number of results to return (default: 5)"),
  }),
  async execute(args, ctx) {
    const deferred = (ctx.extra?.deferredTools as ToolSearch.DeferredToolInfo[]) ?? []

    if (deferred.length === 0) {
      return {
        title: "ToolSearch",
        metadata: {},
        output: "No deferred tools available.",
      }
    }

    const results = ToolSearch.search(args.query, deferred, args.max_results ?? 5)

    if (results.length === 0) {
      return {
        title: "ToolSearch: no matches",
        metadata: {},
        output: `No tools matched query "${args.query}". Available deferred tools: ${deferred.map((t) => t.id).join(", ")}`,
      }
    }

    for (const tool of results) {
      ToolSearch.activateTool(ctx.sessionID, tool)
    }

    const output = results
      .map((t) => {
        return [
          `## ${t.id}`,
          `Description: ${t.description}`,
          `Parameters: ${JSON.stringify(t.parameters, null, 2)}`,
        ].join("\n")
      })
      .join("\n\n---\n\n")

    return {
      title: `ToolSearch: ${results.length} tools loaded`,
      metadata: {},
      output: `Loaded ${results.length} tool(s):\n\n${output}`,
    }
  },
})
