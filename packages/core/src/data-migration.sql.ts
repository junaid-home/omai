import { namespace, safeInteger } from "./database/schema.sql"
import { text } from "drizzle-orm/pg-core"

export const DataMigrationTable = namespace.table("data_migration", {
  name: text().primaryKey(),
  time_completed: safeInteger().notNull(),
})
