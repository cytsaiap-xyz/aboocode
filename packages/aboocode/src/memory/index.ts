import { Database, eq, desc } from "@/storage/db"
import { MemoryTable, EntityTable, RelationTable } from "./memory.sql"
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
  // Row <-> domain object conversions
  function memoryFromRow(row: typeof MemoryTable.$inferSelect): MemoryTypes.MemoryEntry {
    return {
      id: row.id,
      projectID: row.project_id,
      sessionID: row.session_id ?? undefined,
      type: row.type as MemoryTypes.MemoryType,
      category: row.category as MemoryTypes.MemoryCategory,
      title: row.title,
      content: row.content,
      tags: JSON.parse(row.tags) as string[],
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function entityFromRow(row: typeof EntityTable.$inferSelect): MemoryTypes.Entity {
    return {
      id: row.id,
      projectID: row.project_id,
      name: row.name,
      type: row.type as MemoryTypes.EntityType,
      observations: JSON.parse(row.observations) as string[],
      tags: JSON.parse(row.tags) as string[],
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function relationFromRow(row: typeof RelationTable.$inferSelect): MemoryTypes.Relation {
    return {
      id: row.id,
      projectID: row.project_id,
      fromEntity: row.from_entity,
      toEntity: row.to_entity,
      type: row.type as MemoryTypes.RelationType,
      description: row.description ?? undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

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

    // Check max memories limit
    const existing = Database.use((db) =>
      db.select().from(MemoryTable).where(eq(MemoryTable.project_id, projectID)).all(),
    )
    if (existing.length >= maxMemories) {
      log.warn("max memories reached, skipping", { maxMemories })
      throw new Error(`Maximum memory limit (${maxMemories}) reached. Delete old memories first.`)
    }

    // Check for duplicates
    const existingMemories = existing.map(memoryFromRow)
    const newText = `${input.title} ${input.content}`
    for (const mem of existingMemories) {
      if (isDuplicate(newText, `${mem.title} ${mem.content}`)) {
        log.info("duplicate memory detected, skipping", { existing: mem.title, new: input.title })
        return mem
      }
    }

    const id = generateId("mem")
    const now = Date.now()
    const row = {
      id,
      project_id: projectID,
      session_id: input.sessionID ?? null,
      type: input.type,
      category: input.category ?? "knowledge",
      title: input.title,
      content: input.content,
      tags: JSON.stringify(input.tags ?? []),
      time_created: now,
      time_updated: now,
    }

    Database.use((db) => db.insert(MemoryTable).values(row).run())
    log.info("memory added", { id, title: input.title })
    return memoryFromRow({ ...row, session_id: row.session_id })
  }

  export function search(query: string, opts?: { limit?: number; type?: MemoryTypes.MemoryType }): MemoryTypes.MemoryEntry[] {
    const projectID = Instance.project.id
    const rows = Database.use((db) =>
      db.select().from(MemoryTable).where(eq(MemoryTable.project_id, projectID)).all(),
    )
    let entries = rows.map(memoryFromRow)

    if (opts?.type) {
      entries = entries.filter((e) => e.type === opts.type)
    }

    const results = searchText(query, entries)
    const limit = opts?.limit ?? 20
    return results.slice(0, limit)
  }

  export function recent(limit?: number): MemoryTypes.MemoryEntry[] {
    const projectID = Instance.project.id
    const rows = Database.use((db) =>
      db
        .select()
        .from(MemoryTable)
        .where(eq(MemoryTable.project_id, projectID))
        .orderBy(desc(MemoryTable.time_created))
        .limit(limit ?? 10)
        .all(),
    )
    return rows.map(memoryFromRow)
  }

  export function remove(id: string): void {
    Database.use((db) => db.delete(MemoryTable).where(eq(MemoryTable.id, id)).run())
    log.info("memory removed", { id })
  }

  export function stats(): MemoryTypes.Stats {
    const projectID = Instance.project.id

    const memories = Database.use((db) =>
      db.select().from(MemoryTable).where(eq(MemoryTable.project_id, projectID)).all(),
    ).map(memoryFromRow)

    const entities = Database.use((db) =>
      db.select().from(EntityTable).where(eq(EntityTable.project_id, projectID)).all(),
    )

    const relations = Database.use((db) =>
      db.select().from(RelationTable).where(eq(RelationTable.project_id, projectID)).all(),
    )

    const byType: Record<string, number> = {}
    const byCategory: Record<string, number> = {}
    const entityByType: Record<string, number> = {}

    for (const m of memories) {
      byType[m.type] = (byType[m.type] ?? 0) + 1
      byCategory[m.category] = (byCategory[m.category] ?? 0) + 1
    }

    for (const e of entities) {
      entityByType[e.type] = (entityByType[e.type] ?? 0) + 1
    }

    return {
      memories: { total: memories.length, byType, byCategory },
      entities: { total: entities.length, byType: entityByType },
      relations: { total: relations.length },
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
    const row = {
      id,
      project_id: projectID,
      name: input.name,
      type: input.type,
      observations: JSON.stringify(input.observations ?? []),
      tags: JSON.stringify(input.tags ?? []),
      time_created: now,
      time_updated: now,
    }

    Database.use((db) => db.insert(EntityTable).values(row).run())
    log.info("entity added", { id, name: input.name })
    return entityFromRow(row)
  }

  export function searchEntities(query: string, opts?: { limit?: number }): MemoryTypes.Entity[] {
    const projectID = Instance.project.id
    const rows = Database.use((db) =>
      db.select().from(EntityTable).where(eq(EntityTable.project_id, projectID)).all(),
    )
    const entities = rows.map(entityFromRow)
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
    const row = {
      id,
      project_id: projectID,
      from_entity: input.fromEntity,
      to_entity: input.toEntity,
      type: input.type,
      description: input.description ?? null,
      time_created: now,
      time_updated: now,
    }

    Database.use((db) => db.insert(RelationTable).values(row).run())
    log.info("relation added", { id, from: input.fromEntity, to: input.toEntity })
    return relationFromRow({ ...row, description: row.description })
  }

  // --- Context building ---

  export async function buildContext(opts?: { limit?: number }): Promise<string[]> {
    if (!(await isEnabled())) return []

    const config = await Config.get()
    const limit = opts?.limit ?? config.memory?.contextLimit ?? 5

    const projectID = Instance.project.id
    const rows = Database.use((db) =>
      db
        .select()
        .from(MemoryTable)
        .where(eq(MemoryTable.project_id, projectID))
        .orderBy(desc(MemoryTable.time_updated))
        .limit(limit)
        .all(),
    )

    if (rows.length === 0) return []
    return buildContextStrings(rows.map(memoryFromRow))
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
        // Clean up memories associated with deleted session
        Database.use((db) =>
          db.delete(MemoryTable).where(eq(MemoryTable.session_id, event.properties.info.id)).run(),
        )
        log.info("cleaned up memories for deleted session", { sessionID: event.properties.info.id })
      } catch (e) {
        log.error("memory cleanup failed", { error: e })
      }
    })

    log.info("memory system initialized")
  }
}
