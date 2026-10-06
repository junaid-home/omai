import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917000000_add_custom_domain_to_publish",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
        ALTER TABLE ${sql.identifier("publish_deployment")} ADD COLUMN ${sql.identifier("custom_domain")} text
      `)
      yield* tx.run(sql`
        ALTER TABLE ${sql.identifier("publish_deployment")} ADD COLUMN ${sql.identifier("custom_domain_status")} text
      `)
    })
  },
} satisfies DatabaseMigration.Migration
