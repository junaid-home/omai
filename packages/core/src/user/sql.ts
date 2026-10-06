import { text } from "drizzle-orm/pg-core"
import { Timestamps, namespace } from "../database/schema.sql"

export const UserTable = namespace.table("user", {
  id: text().primaryKey(),
  username: text().notNull().unique(),
  email: text().notNull().unique(),
  password_hash: text().notNull(),
  ...Timestamps,
})
