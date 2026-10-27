import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { id, ref, timestamp } from "../columns.ts";
import { agentCallKinds, authors, changeOperations, connectionEndReasons, journaledTables } from "../enums.ts";

export const agentConnection = sqliteTable(
  "agent_connection",
  {
    id: id(),
    client: text("client").notNull(),
    host: text("host").notNull(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    endReason: text("end_reason", { enum: connectionEndReasons }),
  },
  (t) => [
    index("agent_connection_started").on(t.startedAt),
    check("agent_connection_end", sql`(${t.endedAt} IS NULL) = (${t.endReason} IS NULL)`),
  ],
);

// Program versions are never reverted by deleting rows: undoing a changeset that created a version creates a new version restoring the previous content.
export const changeset = sqliteTable(
  "changeset",
  {
    id: id(),
    author: text("author", { enum: authors }).notNull(),
    connectionId: ref("connection_id").references(() => agentConnection.id),
    summary: text("summary").notNull(),
    revertsId: ref("reverts_id"),
    // Changeset committed just before this one for rows it needs (exercises created by an agent session); undone with it when possible.
    companionId: ref("companion_id").references((): AnySQLiteColumn => changeset.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("changeset_created").on(t.createdAt),
    uniqueIndex("changeset_reverts").on(t.revertsId),
    check("changeset_agent", sql`(${t.author} = 'agent') = (${t.connectionId} IS NOT NULL)`),
  ],
);

export const change = sqliteTable(
  "change",
  {
    changesetId: ref("changeset_id").notNull().references(() => changeset.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    tableName: text("table_name", { enum: journaledTables }).notNull(),
    rowId: text("row_id").notNull(),
    operation: text("operation", { enum: changeOperations }).notNull(),
    before: text("before", { mode: "json" }).$type<Record<string, unknown>>(),
    after: text("after", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.changesetId, t.sequence] }),
    index("change_row").on(t.tableName, t.rowId),
    check(
      "change_images",
      sql`(${t.operation} = 'insert' AND ${t.before} IS NULL AND ${t.after} IS NOT NULL) OR (${t.operation} = 'update' AND ${t.before} IS NOT NULL AND ${t.after} IS NOT NULL) OR (${t.operation} = 'delete' AND ${t.before} IS NOT NULL AND ${t.after} IS NULL)`,
    ),
  ],
);

export const agentCall = sqliteTable(
  "agent_call",
  {
    id: id(),
    connectionId: ref("connection_id").notNull().references(() => agentConnection.id),
    tool: text("tool").notNull(),
    kind: text("kind", { enum: agentCallKinds }).notNull(),
    summary: text("summary").notNull(),
    changesetId: ref("changeset_id").references(() => changeset.id),
    calledAt: timestamp("called_at").notNull(),
  },
  (t) => [
    index("agent_call_connection").on(t.connectionId, t.calledAt),
    check("agent_call_write", sql`${t.changesetId} IS NULL OR ${t.kind} = 'write'`),
  ],
);
