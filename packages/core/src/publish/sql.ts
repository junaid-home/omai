import { text, index } from "drizzle-orm/pg-core"
import { ProjectTable } from "../project/sql"
import { Timestamps, namespace } from "../database/schema.sql"

export const PublishDeploymentTable = namespace.table(
  "publish_deployment",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text(),
    name: text().notNull(),
    label: text().notNull(),
    url: text().notNull(),
    cf_project_name: text().notNull(),
    cf_deployment_id: text(),
    status: text().notNull().$type<"deploying" | "live" | "failed">(),
    custom_domain: text(),
    custom_domain_status: text().$type<"initializing" | "pending" | "active" | "error">(),
    runtime: text().$type<"pages" | "workers">(),
    ...Timestamps,
  },
  (table) => [index("publish_deployment_project_idx").on(table.project_id, table.time_created, table.id)],
)
