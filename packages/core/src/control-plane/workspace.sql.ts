import { namespace, safeInteger } from "../database/schema.sql"
import { text, jsonb } from "drizzle-orm/pg-core"
import { ProjectTable } from "../project/sql"
import { ProjectV2 } from "../project"
import { WorkspaceV2 } from "../workspace"

export const WorkspaceTable = namespace.table("workspace", {
  id: text().$type<WorkspaceV2.ID>().primaryKey(),
  type: text().notNull(),
  name: text().notNull().default(""),
  branch: text(),
  directory: text(),
  extra: jsonb(),
  project_id: text()
    .$type<ProjectV2.ID>()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  time_used: safeInteger()
    .notNull()
    .$default(() => Date.now()),
})
