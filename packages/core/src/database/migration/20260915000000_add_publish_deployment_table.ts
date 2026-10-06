import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260915000000_add_publish_deployment_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
        CREATE TABLE IF NOT EXISTS ${sql.identifier("publish_deployment")} (
          ${sql.identifier("id")} text PRIMARY KEY,
          ${sql.identifier("project_id")} text NOT NULL REFERENCES ${sql.identifier("project")}(${sql.identifier("id")}) ON DELETE CASCADE,
          ${sql.identifier("session_id")} text,
          ${sql.identifier("name")} text NOT NULL,
          ${sql.identifier("label")} text NOT NULL,
          ${sql.identifier("url")} text NOT NULL,
          ${sql.identifier("cf_project_name")} text NOT NULL,
          ${sql.identifier("cf_deployment_id")} text,
          ${sql.identifier("status")} text NOT NULL,
          ${sql.identifier("time_created")} integer NOT NULL,
          ${sql.identifier("time_updated")} integer NOT NULL
        )
      `)
      yield* tx.run(
        sql`CREATE INDEX IF NOT EXISTS ${sql.identifier("publish_deployment_project_idx")} ON ${sql.identifier("publish_deployment")} (${sql.identifier("project_id")})`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
