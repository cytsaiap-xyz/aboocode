export namespace MemoryTypes {
  export type MemoryType = "decision" | "pattern" | "bugfix" | "lesson" | "feature" | "note"
  export type MemoryCategory = "solution" | "knowledge"
  export type EntityType = "component" | "file" | "technology" | "pattern" | "decision"
  export type RelationType = "depends_on" | "implements" | "related_to" | "uses"

  export interface MemoryEntry {
    id: string
    projectID: string
    sessionID?: string
    type: MemoryType
    category: MemoryCategory
    title: string
    content: string
    tags: string[]
    time: {
      created: number
      updated: number
    }
  }

  export interface Entity {
    id: string
    projectID: string
    name: string
    type: EntityType
    observations: string[]
    tags: string[]
    time: {
      created: number
      updated: number
    }
  }

  export interface Relation {
    id: string
    projectID: string
    fromEntity: string
    toEntity: string
    type: RelationType
    description?: string
    time: {
      created: number
      updated: number
    }
  }

  export interface Stats {
    memories: {
      total: number
      byType: Record<string, number>
      byCategory: Record<string, number>
    }
    entities: {
      total: number
      byType: Record<string, number>
    }
    relations: {
      total: number
    }
  }

  export interface ExtractedMemory {
    type: MemoryType
    category: MemoryCategory
    title: string
    content: string
    tags: string[]
  }
}
