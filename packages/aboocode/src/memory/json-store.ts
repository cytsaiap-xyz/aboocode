import path from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import type { MemoryTypes } from "./types"

const log = Log.create({ service: "memory.json-store" })

export interface JsonMemoryData {
  memories: MemoryTypes.MemoryEntry[]
  entities: MemoryTypes.Entity[]
  relations: MemoryTypes.Relation[]
}

const EMPTY_DATA: JsonMemoryData = {
  memories: [],
  entities: [],
  relations: [],
}

function getStorePath(projectID: string): string {
  const dir = path.join(Global.Path.data, "memory")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, `${projectID}.json`)
}

export namespace JsonStore {
  export function load(projectID?: string): JsonMemoryData {
    const pid = projectID ?? Instance.project.id
    const filePath = getStorePath(pid)
    if (!existsSync(filePath)) {
      return structuredClone(EMPTY_DATA)
    }
    try {
      const raw = readFileSync(filePath, "utf-8")
      const data = JSON.parse(raw) as JsonMemoryData
      return {
        memories: data.memories ?? [],
        entities: data.entities ?? [],
        relations: data.relations ?? [],
      }
    } catch (e) {
      log.error("failed to read memory JSON file, returning empty", { path: filePath, error: e })
      return structuredClone(EMPTY_DATA)
    }
  }

  export function save(data: JsonMemoryData, projectID?: string): void {
    const pid = projectID ?? Instance.project.id
    const filePath = getStorePath(pid)
    try {
      const json = JSON.stringify(data, null, 2)
      writeFileSync(filePath, json, "utf-8")
    } catch (e) {
      log.error("failed to write memory JSON file", { path: filePath, error: e })
      throw e
    }
  }

  // --- Memory CRUD ---

  export function getAllMemories(projectID?: string): MemoryTypes.MemoryEntry[] {
    return load(projectID).memories
  }

  export function addMemory(entry: MemoryTypes.MemoryEntry, projectID?: string): void {
    const data = load(projectID)
    data.memories.push(entry)
    save(data, projectID)
  }

  export function removeMemory(id: string, projectID?: string): void {
    const data = load(projectID)
    data.memories = data.memories.filter((m) => m.id !== id)
    save(data, projectID)
  }

  export function removeMemoriesBySession(sessionID: string, projectID?: string): void {
    const data = load(projectID)
    data.memories = data.memories.filter((m) => m.sessionID !== sessionID)
    save(data, projectID)
  }

  // --- Entity CRUD ---

  export function getAllEntities(projectID?: string): MemoryTypes.Entity[] {
    return load(projectID).entities
  }

  export function addEntity(entity: MemoryTypes.Entity, projectID?: string): void {
    const data = load(projectID)
    data.entities.push(entity)
    save(data, projectID)
  }

  // --- Relation CRUD ---

  export function getAllRelations(projectID?: string): MemoryTypes.Relation[] {
    return load(projectID).relations
  }

  export function addRelation(relation: MemoryTypes.Relation, projectID?: string): void {
    const data = load(projectID)
    data.relations.push(relation)
    save(data, projectID)
  }
}
