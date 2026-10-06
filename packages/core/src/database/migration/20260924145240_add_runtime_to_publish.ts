import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924145240_add_runtime_to_publish",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`publish_deployment\` ADD \`runtime\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
