import { text, primaryKey, jsonb } from "drizzle-orm/pg-core"
import * as DatabasePath from "../database/path"
import { Timestamps, namespace, safeInteger } from "../database/schema.sql"
import { ProjectSchema } from "./schema"

export const ProjectTable = namespace.table("project", {
  id: text().$type<ProjectSchema.ID>().primaryKey(),
  worktree: DatabasePath.absoluteColumn().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: safeInteger(),
  sandboxes: DatabasePath.absoluteArrayColumn().notNull(),
  commands: jsonb().$type<{ start?: string }>(),
})

export const ProjectDirectoryTable = namespace.table(
  "project_directory",
  {
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: DatabasePath.absoluteColumn().notNull(),
    type: text().$type<"main" | "root" | "git_worktree">(),
    strategy: text(),
    time_created: safeInteger()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.directory] })],
)
