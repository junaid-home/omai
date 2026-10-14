import { jsonb, text } from "drizzle-orm/pg-core"
import { Timestamps, namespace } from "../database/schema.sql"
import type { RawSettingsPermissions } from "./permissions"

export type AssignedModel = { readonly providerID: string; readonly modelID: string }

export const UserTable = namespace.table("user", {
  id: text().primaryKey(),
  username: text().notNull().unique(),
  email: text().notNull().unique(),
  password_hash: text().notNull(),
  role: text().notNull().default("member"),
  settings_permissions: jsonb().$type<RawSettingsPermissions | null>(),
  model: jsonb().$type<AssignedModel | null>(),
  ...Timestamps,
})
