import z from "zod"
import { Tool } from "./tool"
import { Memory } from "../memory"
import type { MemoryTypes } from "../memory/types"

export const MemorySearchTool = Tool.define("memory_search", {
  description: "Search project memories by query. Returns memories matching the search terms, filtered by optional type.",
  parameters: z.object({
    query: z.string().describe("Search query to find relevant memories"),
    type: z
      .enum(["decision", "pattern", "bugfix", "lesson", "feature", "note"])
      .optional()
      .describe("Filter by memory type"),
    limit: z.number().optional().describe("Max results to return (default: 20)"),
  }),
  async execute(params) {
    const results = await Memory.search(params.query, {
      limit: params.limit,
      type: params.type as MemoryTypes.MemoryType | undefined,
    })
    if (results.length === 0) {
      return { title: "memory_search", output: "No memories found matching the query.", metadata: { count: 0 } }
    }
    const lines = results.map(
      (m) => `[${m.id}] [${m.type}] ${m.title}\n  ${m.content}${m.tags.length > 0 ? `\n  Tags: ${m.tags.join(", ")}` : ""}`,
    )
    return { title: "memory_search", output: lines.join("\n\n"), metadata: { count: results.length } }
  },
})

export const MemoryAddTool = Tool.define("memory_add", {
  description:
    "Add a new memory to the project. Use this to record decisions, patterns, bugfixes, lessons learned, or other knowledge worth remembering across sessions.",
  parameters: z.object({
    title: z.string().describe("Short descriptive title for the memory"),
    content: z.string().describe("Detailed content of the memory"),
    type: z
      .enum(["decision", "pattern", "bugfix", "lesson", "feature", "note"])
      .describe("Type of memory"),
    category: z
      .enum(["solution", "knowledge"])
      .optional()
      .describe("Category: solution (actionable) or knowledge (informational). Default: knowledge"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
  }),
  async execute(params) {
    const entry = await Memory.add({
      title: params.title,
      content: params.content,
      type: params.type as MemoryTypes.MemoryType,
      category: params.category as MemoryTypes.MemoryCategory | undefined,
      tags: params.tags,
    })
    return {
      title: "memory_add",
      output: `Memory added: [${entry.id}] ${entry.title}`,
      metadata: { id: entry.id },
    }
  },
})

export const MemoryRecentTool = Tool.define("memory_recent", {
  description: "List the most recent memories for the current project.",
  parameters: z.object({
    limit: z.number().optional().describe("Number of memories to return (default: 10)"),
  }),
  async execute(params) {
    const results = await Memory.recent(params.limit)
    if (results.length === 0) {
      return { title: "memory_recent", output: "No memories found for this project.", metadata: { count: 0 } }
    }
    const lines = results.map(
      (m) =>
        `[${m.id}] [${m.type}] ${m.title}\n  ${m.content}${m.tags.length > 0 ? `\n  Tags: ${m.tags.join(", ")}` : ""}\n  Created: ${new Date(m.time.created).toISOString()}`,
    )
    return { title: "memory_recent", output: lines.join("\n\n"), metadata: { count: results.length } }
  },
})

export const MemoryDeleteTool = Tool.define("memory_delete", {
  description: "Delete a memory by its ID.",
  parameters: z.object({
    id: z.string().describe("The memory ID to delete (e.g., mem_abc123)"),
  }),
  async execute(params) {
    await Memory.remove(params.id)
    return {
      title: "memory_delete",
      output: `Memory ${params.id} deleted.`,
      metadata: { id: params.id },
    }
  },
})

export const MemoryStatsTool = Tool.define("memory_stats", {
  description: "Show statistics about the project's memory system including counts by type and category.",
  parameters: z.object({}),
  async execute() {
    const s = await Memory.stats()
    const lines = [
      `Memories: ${s.memories.total}`,
      ...Object.entries(s.memories.byType).map(([type, count]) => `  ${type}: ${count}`),
      `Entities: ${s.entities.total}`,
      ...Object.entries(s.entities.byType).map(([type, count]) => `  ${type}: ${count}`),
      `Relations: ${s.relations.total}`,
    ]
    return { title: "memory_stats", output: lines.join("\n"), metadata: { ...s } }
  },
})

export const MemoryEntityAddTool = Tool.define("memory_entity_add", {
  description:
    "Add a knowledge graph entity. Entities represent components, files, technologies, patterns, or decisions in the project.",
  parameters: z.object({
    name: z.string().describe("Entity name"),
    type: z.enum(["component", "file", "technology", "pattern", "decision"]).describe("Entity type"),
    observations: z.array(z.string()).optional().describe("Observations about this entity"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
  }),
  async execute(params) {
    const entity = await Memory.addEntity({
      name: params.name,
      type: params.type as MemoryTypes.EntityType,
      observations: params.observations,
      tags: params.tags,
    })
    return {
      title: "memory_entity_add",
      output: `Entity added: [${entity.id}] ${entity.name} (${entity.type})`,
      metadata: { id: entity.id },
    }
  },
})

export const MemoryEntitySearchTool = Tool.define("memory_entity_search", {
  description: "Search knowledge graph entities by name or type.",
  parameters: z.object({
    query: z.string().describe("Search query for entity name, type, or observations"),
    limit: z.number().optional().describe("Max results (default: 20)"),
  }),
  async execute(params) {
    const results = await Memory.searchEntities(params.query, { limit: params.limit })
    if (results.length === 0) {
      return { title: "memory_entity_search", output: "No entities found.", metadata: { count: 0 } }
    }
    const lines = results.map(
      (e) =>
        `[${e.id}] ${e.name} (${e.type})${e.observations.length > 0 ? `\n  Observations: ${e.observations.join("; ")}` : ""}`,
    )
    return { title: "memory_entity_search", output: lines.join("\n\n"), metadata: { count: results.length } }
  },
})

export const MemoryRelationAddTool = Tool.define("memory_relation_add", {
  description: "Create a relationship between two knowledge graph entities.",
  parameters: z.object({
    from_entity: z.string().describe("Source entity name or ID"),
    to_entity: z.string().describe("Target entity name or ID"),
    type: z.enum(["depends_on", "implements", "related_to", "uses"]).describe("Relationship type"),
    description: z.string().optional().describe("Description of the relationship"),
  }),
  async execute(params) {
    const relation = await Memory.addRelation({
      fromEntity: params.from_entity,
      toEntity: params.to_entity,
      type: params.type as MemoryTypes.RelationType,
      description: params.description,
    })
    return {
      title: "memory_relation_add",
      output: `Relation added: ${params.from_entity} --[${params.type}]--> ${params.to_entity}`,
      metadata: { id: relation.id },
    }
  },
})
