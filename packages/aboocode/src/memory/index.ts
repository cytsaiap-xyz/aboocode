import { Database, eq, desc } from "@/storage/db"
import { MemoryTable, EntityTable, RelationTable } from "./memory.sql"
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

async function useJson(): Promise<boolean> {
  const config = await Config.get()
  return config.memory?.storageBackend === "json"
}

function useJsonSync(config: Config.Info): boolean {
  return config.memory?.storageBackend === "json"
}

export namespace Memory {
  // Row <-> domain object conversions (SQLite only)
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
    const json = useJsonSync(config)

    // Get existing memories
    const existingMemories = json
      ? JsonStore.getAllMemories()
      : Database.use((db) =>
          db.select().from(MemoryTable).where(eq(MemoryTable.project_id, projectID)).all(),
        ).map(memoryFromRow)

    // Check max memories limit
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

    if (json) {
      JsonStore.addMemory(entry)
    } else {
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
    }

    log.info("memory added", { id, title: input.title, backend: json ? "json" : "sqlite" })
    return entry
  }

  export async function search(
    query: string,
    opts?: { limit?: number; type?: MemoryTypes.MemoryType },
  ): Promise<MemoryTypes.MemoryEntry[]> {
    const projectID = Instance.project.id
    const json = await useJson()

    let entries: MemoryTypes.MemoryEntry[]
    if (json) {
      entries = JsonStore.getAllMemories()
    } else {
      const rows = Database.use((db) =>
        db.select().from(MemoryTable).where(eq(MemoryTable.project_id, projectID)).all(),
      )
      entries = rows.map(memoryFromRow)
    }

    if (opts?.type) {
      entries = entries.filter((e) => e.type === opts.type)
    }

    const results = searchText(query, entries)
    const limit = opts?.limit ?? 20
    return results.slice(0, limit)
  }

  export async function recent(limit?: number): Promise<MemoryTypes.MemoryEntry[]> {
    const projectID = Instance.project.id
    const json = await useJson()
    const n = limit ?? 10

    if (json) {
      const all = JsonStore.getAllMemories()
      return all.sort((a, b) => b.time.created - a.time.created).slice(0, n)
    }

    const rows = Database.use((db) =>
      db
        .select()
        .from(MemoryTable)
        .where(eq(MemoryTable.project_id, projectID))
        .orderBy(desc(MemoryTable.time_created))
        .limit(n)
        .all(),
    )
    return rows.map(memoryFromRow)
  }

  export async function remove(id: string): Promise<void> {
    const json = await useJson()

    if (json) {
      JsonStore.removeMemory(id)
    } else {
      Database.use((db) => db.delete(MemoryTable).where(eq(MemoryTable.id, id)).run())
    }

    log.info("memory removed", { id, backend: json ? "json" : "sqlite" })
  }

  export async function stats(): Promise<MemoryTypes.Stats> {
    const projectID = Instance.project.id
    const json = await useJson()

    let memories: MemoryTypes.MemoryEntry[]
    let entityCount: number
    let entityTypes: Record<string, number>
    let relationCount: number

    if (json) {
      const data = JsonStore.load()
      memories = data.memories
      entityCount = data.entities.length
      entityTypes = {}
      for (const e of data.entities) {
        entityTypes[e.type] = (entityTypes[e.type] ?? 0) + 1
      }
      relationCount = data.relations.length
    } else {
      memories = Database.use((db) =>
        db.select().from(MemoryTable).where(eq(MemoryTable.project_id, projectID)).all(),
      ).map(memoryFromRow)

      const entities = Database.use((db) =>
        db.select().from(EntityTable).where(eq(EntityTable.project_id, projectID)).all(),
      )

      const relations = Database.use((db) =>
        db.select().from(RelationTable).where(eq(RelationTable.project_id, projectID)).all(),
      )

      entityCount = entities.length
      entityTypes = {}
      for (const e of entities) {
        entityTypes[e.type] = (entityTypes[e.type] ?? 0) + 1
      }
      relationCount = relations.length
    }

    const byType: Record<string, number> = {}
    const byCategory: Record<string, number> = {}
    for (const m of memories) {
      byType[m.type] = (byType[m.type] ?? 0) + 1
      byCategory[m.category] = (byCategory[m.category] ?? 0) + 1
    }

    return {
      memories: { total: memories.length, byType, byCategory },
      entities: { total: entityCount, byType: entityTypes },
      relations: { total: relationCount },
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
    const json = await useJson()

    const entity: MemoryTypes.Entity = {
      id,
      projectID,
      name: input.name,
      type: input.type,
      observations: input.observations ?? [],
      tags: input.tags ?? [],
      time: { created: now, updated: now },
    }

    if (json) {
      JsonStore.addEntity(entity)
    } else {
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
    }

    log.info("entity added", { id, name: input.name, backend: json ? "json" : "sqlite" })
    return entity
  }

  export async function searchEntities(query: string, opts?: { limit?: number }): Promise<MemoryTypes.Entity[]> {
    const projectID = Instance.project.id
    const json = await useJson()

    let entities: MemoryTypes.Entity[]
    if (json) {
      entities = JsonStore.getAllEntities()
    } else {
      const rows = Database.use((db) =>
        db.select().from(EntityTable).where(eq(EntityTable.project_id, projectID)).all(),
      )
      entities = rows.map(entityFromRow)
    }

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
    const json = await useJson()

    const relation: MemoryTypes.Relation = {
      id,
      projectID,
      fromEntity: input.fromEntity,
      toEntity: input.toEntity,
      type: input.type,
      description: input.description,
      time: { created: now, updated: now },
    }

    if (json) {
      JsonStore.addRelation(relation)
    } else {
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
    }

    log.info("relation added", { id, from: input.fromEntity, to: input.toEntity, backend: json ? "json" : "sqlite" })
    return relation
  }

  // --- Context building ---

  export async function buildContext(opts?: { limit?: number }): Promise<string[]> {
    if (!(await isEnabled())) return []

    const config = await Config.get()
    const limit = opts?.limit ?? config.memory?.contextLimit ?? 5
    const json = useJsonSync(config)

    const projectID = Instance.project.id

    let memories: MemoryTypes.MemoryEntry[]
    if (json) {
      const all = JsonStore.getAllMemories()
      memories = all.sort((a, b) => b.time.updated - a.time.updated).slice(0, limit)
    } else {
      const rows = Database.use((db) =>
        db
          .select()
          .from(MemoryTable)
          .where(eq(MemoryTable.project_id, projectID))
          .orderBy(desc(MemoryTable.time_updated))
          .limit(limit)
          .all(),
      )
      memories = rows.map(memoryFromRow)
    }

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
        const json = await useJson()
        if (json) {
          JsonStore.removeMemoriesBySession(event.properties.info.id)
        } else {
          Database.use((db) =>
            db.delete(MemoryTable).where(eq(MemoryTable.session_id, event.properties.info.id)).run(),
          )
        }
        log.info("cleaned up memories for deleted session", { sessionID: event.properties.info.id })
      } catch (e) {
        log.error("memory cleanup failed", { error: e })
      }
    })

    log.info("memory system initialized")
  }
}
