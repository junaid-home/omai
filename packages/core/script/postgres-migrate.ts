import { Effect } from "effect"
import { Database } from "../src/database/database"
import { PostgreSQLMigration } from "../src/database/postgres/migration"

const url = Database.connectionURLFromEnvironment("OPENCODE_DATABASE_MIGRATOR_URL")
const instanceID = process.env.OPENCODE_INSTANCE_ID
const schema = process.env.OPENCODE_DATABASE_SCHEMA
const runtimeRole = process.env.OPENCODE_DATABASE_RUNTIME_ROLE
if (!instanceID || !schema) throw new Error("Migration requires OPENCODE_INSTANCE_ID and OPENCODE_DATABASE_SCHEMA")

await Effect.runPromise(
  Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      const ownership = yield* Database.claimRuntime(db, instanceID)
      yield* Effect.gen(function* () {
        yield* PostgreSQLMigration.apply(db, { instanceID })
        if (runtimeRole !== undefined) yield* PostgreSQLMigration.grantRuntime(db, { role: runtimeRole })
      }).pipe(Effect.raceFirst(ownership.lost))
    }),
  ).pipe(Effect.provide(Database.layerFromConfig({ url, instanceID, schema, mode: "migration" })), Effect.scoped),
)
console.log(`PostgreSQL schema ${schema} is ready for instance ${instanceID}`)
