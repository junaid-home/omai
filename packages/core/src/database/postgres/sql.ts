import { boolean, check, text } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { namespace, safeInteger } from "../schema.sql"

export const InstanceMetadataTable = namespace.table(
  "instance_metadata",
  {
    singleton: boolean().primaryKey().default(true),
    instance_id: text().notNull(),
    time_created: safeInteger().notNull(),
  },
  (table) => [check("instance_metadata_singleton", sql`${table.singleton} = true`)],
)

export const SchemaMigrationTable = namespace.table("schema_migration", {
  id: text().primaryKey(),
  checksum: text().notNull(),
  time_completed: safeInteger().notNull(),
})
