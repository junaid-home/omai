import { customType, pgSchema } from "drizzle-orm/pg-core"

/** Every table is qualified, so a pooled connection cannot change its instance by changing search_path. */
export const schemaName = process.env.OPENCODE_DATABASE_SCHEMA ?? "opencode"
if (
  !/^[a-z][a-z0-9_]{0,62}$/.test(schemaName) ||
  ["public", "information_schema"].includes(schemaName) ||
  schemaName.startsWith("pg_")
) {
  throw new Error("OPENCODE_DATABASE_SCHEMA must be a dedicated lowercase PostgreSQL schema name")
}
export const namespace = pgSchema(schemaName)

/** Preserve the existing millisecond/sequence number contracts without silently rounding PostgreSQL int8 values. */
export const safeInteger = customType<{ data: number; driverData: string; driverOutput: string | number | bigint }>({
  dataType: () => "bigint",
  toDriver(value) {
    if (!Number.isSafeInteger(value)) throw new RangeError("Database integer exceeds the JavaScript safe integer range")
    return String(value)
  },
  fromDriver(value) {
    const result = Number(value)
    if (!Number.isSafeInteger(result))
      throw new RangeError("Database integer exceeds the JavaScript safe integer range")
    return result
  },
})

export const Timestamps = {
  time_created: safeInteger()
    .notNull()
    .$default(() => Date.now()),
  time_updated: safeInteger()
    .notNull()
    .$onUpdate(() => Date.now()),
}
