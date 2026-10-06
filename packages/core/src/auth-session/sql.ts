import { index, text } from "drizzle-orm/pg-core"
import { namespace, safeInteger } from "../database/schema.sql"
import { UserTable } from "../user/sql"

export const AuthSessionTable = namespace.table(
  "auth_session",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    time_created: safeInteger().notNull(),
    time_expires: safeInteger().notNull(),
    time_revoked: safeInteger(),
  },
  (table) => [
    index("auth_session_user_expiry_idx").on(table.user_id, table.time_expires),
    index("auth_session_expiry_idx").on(table.time_expires),
  ],
)
