import { index, primaryKey, text } from "drizzle-orm/pg-core"
import { namespace, safeInteger } from "../database/schema.sql"
import { UserTable } from "../user/sql"

/** Null value is a retained deletion tombstone; revision always advances on successful CAS writes. */
export const UserStateTable = namespace.table(
  "user_state",
  {
    user_id: text()
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    namespace: text().notNull(),
    key: text().notNull(),
    value: text(),
    revision: safeInteger().notNull(),
    time_updated: safeInteger().notNull(),
    time_deleted: safeInteger(),
  },
  (table) => [
    primaryKey({ columns: [table.user_id, table.namespace, table.key] }),
    index("user_state_user_updated_idx").on(table.user_id, table.time_updated),
  ],
)
