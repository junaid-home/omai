import { primaryKey, text } from "drizzle-orm/pg-core"
import { namespace, safeInteger } from "../database/schema.sql"

/** Values contain authenticated encrypted envelopes; namespace and key are included in their additional authenticated data. */
export const InstanceStateTable = namespace.table(
  "instance_state",
  {
    namespace: text().notNull(),
    key: text().notNull(),
    value: text().notNull(),
    revision: safeInteger().notNull().default(1),
    time_updated: safeInteger().notNull(),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.key] })],
)
