import { namespace, safeInteger } from "../database/schema.sql"
import { text, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core"
import type { EventV2 } from "../event"

export const EventSequenceTable = namespace.table("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: safeInteger().notNull(),
  owner_id: text(),
})

export const EventTable = namespace.table(
  "event",
  {
    id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: safeInteger().notNull(),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
  ],
)
