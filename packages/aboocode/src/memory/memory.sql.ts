import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { Timestamps } from "@/storage/schema.sql"

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text(),
    type: text().notNull(),
    category: text().notNull(),
    title: text().notNull(),
    content: text().notNull(),
    tags: text().notNull().default("[]"),
    ...Timestamps,
  },
  (table) => [index("memory_project_idx").on(table.project_id)],
)

export const EntityTable = sqliteTable(
  "entity",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    type: text().notNull(),
    observations: text().notNull().default("[]"),
    tags: text().notNull().default("[]"),
    ...Timestamps,
  },
  (table) => [index("entity_project_idx").on(table.project_id)],
)

export const RelationTable = sqliteTable(
  "relation",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    from_entity: text().notNull(),
    to_entity: text().notNull(),
    type: text().notNull(),
    description: text(),
    ...Timestamps,
  },
  (table) => [index("relation_project_idx").on(table.project_id)],
)
