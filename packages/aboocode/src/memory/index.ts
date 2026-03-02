import { JsonStore } from "./json-store"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session"
import { randomUUID } from "crypto"
import type { MemoryTypes } from "./types"
import { searchText, searchEntities as searchEntitiesText, isDuplicate } from "./search"
import { buildContextStrings } from "./context"

const log = Log.create({ service: "memory" })

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`
}

export namespace Memory {
  async function isEnabled(): Promise<boolean> {
    const config = await Config.get()
    return config.memory?.enabled !== false
  }

  // --- CRUD ---

  export async function add(input: {
    title: string
    content: string
    type: MemoryTypes.MemoryType
    category?: MemoryTypes.MemoryCategory
    tags?: string[]
    sessionID?: string
  }): Promise<MemoryTypes.MemoryEntry> {
    if (!(await isEnabled())) throw new Error("Memory system is disabled")

    const projectID = Instance.project.id
    const config = await Config.get()
    const maxMemories = config.memory?.maxMemories ?? 500

    const existingMemories = JsonStore.getAllMemories()

    if (existingMemories.length >= maxMemories) {
      log.warn("max memories reached, skipping", { maxMemories })
      throw new Error(`Maximum memory limit (${maxMemories}) reached. Delete old memories first.`)
    }

    // Check for duplicates
    const newText = `${input.title} ${input.content}`
    for (const mem of existingMemories) {
      if (isDuplicate(newText, `${mem.title} ${mem.content}`)) {
        log.info("duplicate memory detected, skipping", { existing: mem.title, new: input.title })
        return mem
      }
    }

    const id = generateId("mem")
    const now = Date.now()

    const entry: MemoryTypes.MemoryEntry = {
      id,
      projectID,
      sessionID: input.sessionID,
      type: input.type,
      category: input.category ?? "knowledge",
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      time: { created: now, updated: now },
    }

    JsonStore.addMemory(entry)
    log.info("memory added", { id, title: input.title })
    return entry
  }

  export async function search(
    query: string,
    opts?: { limit?: number; type?: MemoryTypes.MemoryType },
  ): Promise<MemoryTypes.MemoryEntry[]> {
    let entries = JsonStore.getAllMemories()

    if (opts?.type) {
      entries = entries.filter((e) => e.type === opts.type)
    }

    const results = searchText(query, entries)
    const limit = opts?.limit ?? 20
    return results.slice(0, limit)
  }

  export async function recent(limit?: number): Promise<MemoryTypes.MemoryEntry[]> {
    const n = limit ?? 10
    const all = JsonStore.getAllMemories()
    return all.sort((a, b) => b.time.created - a.time.created).slice(0, n)
  }

  export async function remove(id: string): Promise<void> {
    JsonStore.removeMemory(id)
    log.info("memory removed", { id })
  }

  export async function stats(): Promise<MemoryTypes.Stats> {
    const data = JsonStore.load()

    const byType: Record<string, number> = {}
    const byCategory: Record<string, number> = {}
    for (const m of data.memories) {
      byType[m.type] = (byType[m.type] ?? 0) + 1
      byCategory[m.category] = (byCategory[m.category] ?? 0) + 1
    }

    const entityByType: Record<string, number> = {}
    for (const e of data.entities) {
      entityByType[e.type] = (entityByType[e.type] ?? 0) + 1
    }

    return {
      memories: { total: data.memories.length, byType, byCategory },
      entities: { total: data.entities.length, byType: entityByType },
      relations: { total: data.relations.length },
    }
  }

  // --- Entity CRUD ---

  export async function addEntity(input: {
    name: string
    type: MemoryTypes.EntityType
    observations?: string[]
    tags?: string[]
  }): Promise<MemoryTypes.Entity> {
    if (!(await isEnabled())) throw new Error("Memory system is disabled")

    const projectID = Instance.project.id
    const id = generateId("ent")
    const now = Date.now()

    const entity: MemoryTypes.Entity = {
      id,
      projectID,
      name: input.name,
      type: input.type,
      observations: input.observations ?? [],
      tags: input.tags ?? [],
      time: { created: now, updated: now },
    }

    JsonStore.addEntity(entity)
    log.info("entity added", { id, name: input.name })
    return entity
  }

  export async function searchEntities(query: string, opts?: { limit?: number }): Promise<MemoryTypes.Entity[]> {
    const entities = JsonStore.getAllEntities()
    const results = searchEntitiesText(query, entities)
    const limit = opts?.limit ?? 20
    return results.slice(0, limit)
  }

  // --- Relation CRUD ---

  export async function addRelation(input: {
    fromEntity: string
    toEntity: string
    type: MemoryTypes.RelationType
    description?: string
  }): Promise<MemoryTypes.Relation> {
    if (!(await isEnabled())) throw new Error("Memory system is disabled")

    const projectID = Instance.project.id
    const id = generateId("rel")
    const now = Date.now()

    const relation: MemoryTypes.Relation = {
      id,
      projectID,
      fromEntity: input.fromEntity,
      toEntity: input.toEntity,
      type: input.type,
      description: input.description,
      time: { created: now, updated: now },
    }

    JsonStore.addRelation(relation)
    log.info("relation added", { id, from: input.fromEntity, to: input.toEntity })
    return relation
  }

  // --- Context building ---

  export async function buildContext(opts?: { limit?: number }): Promise<string[]> {
    if (!(await isEnabled())) return []

    const config = await Config.get()
    const limit = opts?.limit ?? config.memory?.contextLimit ?? 5

    const all = JsonStore.getAllMemories()
    const memories = all.sort((a, b) => b.time.updated - a.time.updated).slice(0, limit)

    if (memories.length === 0) return []
    return buildContextStrings(memories)
  }

  // --- Initialization ---

  let initialized = false

  export function init(): void {
    if (initialized) return
    initialized = true

    Bus.subscribe(SessionStatus.Event.Status, async (event) => {
      if (event.properties.status.type !== "idle") return
      try {
        if (!(await isEnabled())) return
        const config = await Config.get()
        if (config.memory?.autoExtract === false) return

        // Dynamic import to avoid circular dependency
        const { extractMemories } = await import("./extract")
        await extractMemories(event.properties.sessionID)
      } catch (e) {
        log.error("memory extraction failed", { error: e })
      }
    })

    Bus.subscribe(Session.Event.Deleted, async (event) => {
      try {
        JsonStore.removeMemoriesBySession(event.properties.info.id)
        log.info("cleaned up memories for deleted session", { sessionID: event.properties.info.id })
      } catch (e) {
        log.error("memory cleanup failed", { error: e })
      }
    })

    log.info("memory system initialized")
  }
}
