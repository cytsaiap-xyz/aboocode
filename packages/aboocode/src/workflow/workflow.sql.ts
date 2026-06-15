import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    name: text().notNull(),
    script_path: text().notNull(),
    status: text().notNull(), // running | paused | done | failed | stopped
    args_json: text(),
    model: text(),
    tokens_total: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("workflow_run_session_idx").on(table.session_id)],
)

export const WorkflowAgentCallTable = sqliteTable(
  "workflow_agent_call",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => WorkflowRunTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    call_key: text().notNull(),
    label: text(),
    phase: text(),
    prompt: text().notNull(),
    opts_json: text(),
    result_json: text(),
    status: text().notNull(), // done | failed
    tokens: integer().notNull().default(0),
    time_started: integer().notNull(),
    time_ended: integer(),
  },
  (table) => [index("workflow_call_run_seq_idx").on(table.run_id, table.seq)],
)
