import { encryptedText } from "../database/secrets"
import { text } from "drizzle-orm/pg-core"
import { SessionTable } from "../session/sql"
import { Timestamps, namespace } from "../database/schema.sql"

export const SessionShareTable = namespace.table("session_share", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  id: text().notNull(),
  secret: encryptedText("session_share", "secret").notNull(),
  url: text().notNull(),
  ...Timestamps,
})
