import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { InstanceStateEncryption } from "../../instance-state/encryption"
import { Database } from "../database"
import { schemaName } from "../schema.sql"

const targets = [
  { table: "instance_state", keys: ["namespace", "key"], columns: ["value"] },
  { table: "credential", keys: ["id"], columns: ["value"] },
  { table: "account", keys: ["id"], columns: ["access_token", "refresh_token"] },
  { table: "control_account", keys: ["email", "url"], columns: ["access_token", "refresh_token"] },
  { table: "session_share", keys: ["session_id"], columns: ["secret"] },
] as const
const qualified = (table: string) => sql`${sql.identifier(schemaName)}.${sql.identifier(table)}`

export class RotationError extends Schema.TaggedErrorClass<RotationError>()("DataKeyRotation.Error", {
  operation: Schema.String,
  table: Schema.optional(Schema.String),
}) {}

export interface Input {
  readonly source: InstanceStateEncryption.Key
  readonly target: InstanceStateEncryption.Key
  readonly apply: boolean
}

/**
 * Offline operation. The command holds the shared-volume runtime flock; this
 * function also excludes application startup through PostgreSQL ownership.
 * Raw SQL deliberately avoids custom column decoders cached by the application.
 */
export const run = Effect.fn("DataKeyRotation.run")(function* (db: Database.Client, input: Input) {
  if (input.source.instanceID !== input.target.instanceID || input.source.secret === input.target.secret) {
    return yield* new RotationError({ operation: "validate-distinct-keys-for-same-instance" })
  }
  const codecs = yield* Effect.try({
    try: () => ({
      source: InstanceStateEncryption.codec(input.source),
      target: InstanceStateEncryption.codec(input.target),
    }),
    catch: () => new RotationError({ operation: "validate-keys" }),
  })
  const ownership = yield* Database.claimRuntime(db, input.source.instanceID)
  const operationID = randomUUID()
  const startedAt = yield* Clock.currentTimeMillis
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        // Long rotations must not be cut off by the application's query deadline.
        // Admission and table locks remain fail-fast under lock_timeout.
        yield* tx.execute(sql`set local statement_timeout = 0`)
        yield* tx.execute(
          sql`lock table ${sql.join(
            targets.map((target) => qualified(target.table)),
            sql`, `,
          )} in access exclusive mode`,
        )
        const identity = yield* tx.execute<{ instance_id: string }>(
          sql`select instance_id from ${qualified("instance_metadata")} where singleton = true`,
        )
        if (identity.length !== 1 || identity[0].instance_id !== input.source.instanceID) {
          return yield* new RotationError({ operation: "verify-instance-identity" })
        }
        const counts: Record<string, number> = {}
        for (const target of targets) {
          const identifiers = target.keys.map((key) => sql.identifier(key))
          const selections = [...identifiers, ...target.columns.map((column) => sql.identifier(column))]
          let cursor: ReadonlyArray<string> | undefined
          let count = 0
          while (true) {
            const filter = cursor
              ? sql`where (${sql.join(identifiers, sql`, `)}) > (${sql.join(
                  cursor.map((value) => sql`${value}`),
                  sql`, `,
                )})`
              : sql.empty()
            const rows = yield* tx.execute<Record<string, string>>(
              sql`select ${sql.join(selections, sql`, `)} from ${qualified(target.table)} ${filter} order by ${sql.join(identifiers, sql`, `)} limit 100`,
            )
            if (!rows.length) break
            for (const row of rows) {
              const changes = yield* Effect.try({
                try: () =>
                  target.columns.map((column) => {
                    const namespace = target.table === "instance_state" ? row.namespace : target.table
                    const key = target.table === "instance_state" ? row.key : column
                    const value = codecs.source.decode(namespace, key, row[column])
                    return sql`${sql.identifier(column)} = ${codecs.target.encode(namespace, key, value)}`
                  }),
                catch: () => new RotationError({ operation: "decrypt-and-reencrypt", table: target.table }),
              })
              if (input.apply) {
                yield* tx.execute(
                  sql`update ${qualified(target.table)} set ${sql.join(changes, sql`, `)} where ${sql.join(
                    target.keys.map((key) => sql`${sql.identifier(key)} = ${row[key]}`),
                    sql` and `,
                  )}`,
                )
              }
              count += 1
            }
            cursor = target.keys.map((key) => rows[rows.length - 1][key])
          }
          counts[target.table] = count
        }
        const report = {
          operationID,
          applied: input.apply,
          instanceID: input.source.instanceID,
          sourceFingerprint: fingerprint(input.source.secret),
          targetFingerprint: fingerprint(input.target.secret),
          startedAt,
          completedAt: yield* Clock.currentTimeMillis,
          rows: counts,
        }
        if (input.apply) {
          yield* tx.execute(
            sql`insert into ${qualified("instance_state")} (namespace, key, value, revision, time_updated) values (${"key-rotation"}, ${operationID}, ${codecs.target.encode("key-rotation", operationID, report)}, 1, ${report.completedAt})`,
          )
        }
        return report
      }),
    )
    .pipe(
      Effect.catchTag("SqlError", () => Effect.fail(new RotationError({ operation: "database-transaction" }))),
      Effect.raceFirst(
        ownership.lost.pipe(Effect.mapError(() => new RotationError({ operation: "runtime-ownership-lost" }))),
      ),
    )
}, Effect.scoped)

function fingerprint(secret: string) {
  return createHash("sha256").update(Buffer.from(secret, "base64")).digest("hex")
}

export * as DataKeyRotation from "./rotate-data-key"
