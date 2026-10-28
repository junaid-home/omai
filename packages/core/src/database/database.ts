export * as Database from "./database"

import { PgClient } from "@effect/sql-pg"
import { readFileSync } from "node:fs"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Context, Deferred, Duration, Effect, Layer, Redacted, Schedule } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { schemaName } from "./schema.sql"
import { PostgreSQLMigration } from "./postgres/migration"

const makeDatabase = makeWithDefaults()
export type Client = Effect.Success<typeof makeDatabase>
export type Transaction = Parameters<Parameters<Client["transaction"]>[0]>[0]

export interface Interface {
  readonly db: Client
}

export interface Config {
  readonly url: string
  readonly instanceID: string
  readonly schema?: string
  readonly maxConnections?: number
  /** How long a query waits for a pooled connection before failing, in seconds. */
  readonly connectTimeout?: number
  /** Migration mode is for the dedicated migration command and isolated tests, never automatic application startup. */
  readonly mode?: "runtime" | "migration"
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

/** PostgreSQL query builders return rows; this is a typed result mapper, not a backend compatibility proxy. */
export const first = <A, E, R>(query: Effect.Effect<ReadonlyArray<A>, E, R>): Effect.Effect<A | undefined, E, R> =>
  query.pipe(Effect.map((rows) => rows[0]))

export function layerFromConfig(config: Config) {
  if (!config.instanceID.trim()) throw new Error("A non-empty PostgreSQL instance ID is required")
  if ((config.schema ?? schemaName) !== schemaName) {
    throw new Error("Database schema must match OPENCODE_DATABASE_SCHEMA configured before module loading")
  }
  if (
    config.maxConnections !== undefined &&
    (!Number.isInteger(config.maxConnections) || config.maxConnections < 2 || config.maxConnections > 100)
  ) {
    throw new Error("PostgreSQL pool size must be an integer between 2 and 100")
  }
  if (
    config.connectTimeout !== undefined &&
    (!Number.isInteger(config.connectTimeout) || config.connectTimeout < 1 || config.connectTimeout > 300)
  ) {
    throw new Error("PostgreSQL connect timeout must be an integer between 1 and 300 seconds")
  }
  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    throw new Error("The PostgreSQL connection URL is invalid")
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("OPENCODE_DATABASE_URL must be a PostgreSQL connection URL")
  }
  explicitSslMode(url)
  // Startup options apply to every pooled connection. Tables are additionally schema-qualified.
  url.searchParams.set(
    "options",
    `-c search_path=${schemaName},pg_catalog -c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000`,
  )
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      if (config.mode !== "migration") yield* PostgreSQLMigration.assertReady(db, { instanceID: config.instanceID })
      return { db }
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provide(
      PgClient.layer({
        url: Redacted.make(url.toString()),
        applicationName: `omai:${config.instanceID}`,
        maxConnections: config.maxConnections ?? 10,
        // pg-pool starts this timer whenever a query waits for a pooled connection, including when
        // free clients exist but the queue has not been drained yet. The JS event loop can stall for
        // seconds under GC and large JSON work, which made the five second timer fire mid-stall and
        // surface as "timeout exceeded when trying to connect" even though the pool was never full.
        connectTimeout: Duration.seconds(config.connectTimeout ?? 30),
        idleTimeout: "30 seconds",
        connectionTTL: "30 minutes",
        transformJson: false,
      }),
    ),
    Layer.orDie,
  )
}

/**
 * pg 8 already treats `prefer`, `require` and `verify-ca` as `verify-full` but
 * warns on every connection that pg 9 will weaken them to libpq semantics.
 * Spelling out `verify-full` keeps today's verification and silences that.
 * URLs that opted into libpq semantics (`uselibpqcompat`) keep their mode.
 */
export function explicitSslMode(url: URL) {
  const mode = url.searchParams.get("sslmode")
  if (url.searchParams.get("uselibpqcompat") === "true") return url
  if (mode === "prefer" || mode === "require" || mode === "verify-ca") url.searchParams.set("sslmode", "verify-full")
  return url
}

/** Mounted secrets and direct environment configuration are mutually exclusive. Never include URL contents in errors. */
export function connectionURLFromEnvironment(name: "OPENCODE_DATABASE_URL" | "OPENCODE_DATABASE_MIGRATOR_URL") {
  const direct = process.env[name]
  const file = process.env[`${name}_FILE`]
  if (direct !== undefined && file !== undefined) throw new Error(`Configure only ${name} or ${name}_FILE`)
  const value = file === undefined ? direct?.trim() : readFileSync(file, "utf8").trim()
  if (!value) throw new Error(`A non-empty ${name} or ${name}_FILE is required`)
  return value
}

export function configFromEnvironment(): Config & { readonly schema: string } {
  const url = connectionURLFromEnvironment("OPENCODE_DATABASE_URL")
  const instanceID = process.env.OPENCODE_INSTANCE_ID
  if (!url || !instanceID || !process.env.OPENCODE_DATABASE_SCHEMA) {
    throw new Error(
      "Central mode requires a PostgreSQL URL, OPENCODE_INSTANCE_ID and OPENCODE_DATABASE_SCHEMA; SQLite fallback is disabled",
    )
  }
  return {
    url,
    instanceID,
    schema: schemaName,
    maxConnections: process.env.OPENCODE_DATABASE_POOL_SIZE
      ? Number(process.env.OPENCODE_DATABASE_POOL_SIZE)
      : undefined,
    connectTimeout: process.env.OPENCODE_DATABASE_CONNECT_TIMEOUT
      ? Number(process.env.OPENCODE_DATABASE_CONNECT_TIMEOUT)
      : undefined,
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.suspend(() => layerFromConfig(configFromEnvironment())),
  deps: [],
})

export class RuntimeOwnershipLost extends Error {
  override readonly name = "RuntimeOwnershipLost"
  constructor() {
    super("The PostgreSQL runtime ownership connection was lost; this process must stop serving and executing work")
  }
}

/**
 * The caller must race its complete serving/execution scope against `lost`.
 * This is a single-runtime safety boundary, not a renewable distributed execution lease.
 */
export const claimRuntime = Effect.fn("Database.claimRuntime")(function* (db: Client, instanceID: string) {
  const connection = yield* db.$client.reserve
  const key = `omai:runtime:${schemaName}:${instanceID}`
  // A session lock can already exist on the server when acquisition is interrupted
  // before its result arrives. Register cleanup first, while the connection is reserved.
  yield* Effect.addFinalizer(() =>
    connection
      .executeUnprepared("select pg_advisory_unlock(hashtextextended($1, 0))", [key], undefined)
      .pipe(Effect.timeout("3 seconds"), Effect.ignore, Effect.asVoid),
  )
  const locked = yield* connection.executeUnprepared(
    "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
    [key],
    undefined,
  )
  if (locked[0]?.locked !== true) return yield* Effect.die("Another runtime already owns this PostgreSQL instance")
  const lost = yield* Deferred.make<never, RuntimeOwnershipLost>()
  const heartbeat = connection
    .executeUnprepared(
      "with identity as (select hashtextextended($1, 0) as key) select exists (select 1 from pg_locks, identity where pid = pg_backend_pid() and locktype = 'advisory' and granted and classid = ((identity.key >> 32) & 4294967295)::oid and objid = (identity.key & 4294967295)::oid and objsubid = 1) as owned",
      [key],
      undefined,
    )
    .pipe(
      Effect.timeout("5 seconds"),
      Effect.flatMap((rows) => (rows[0]?.owned === true ? Effect.void : Effect.fail(new RuntimeOwnershipLost()))),
    )
  yield* heartbeat.pipe(
    Effect.repeat(Schedule.spaced("2 seconds")),
    Effect.catchCause(() => Deferred.fail(lost, new RuntimeOwnershipLost())),
    Effect.forkScoped,
  )
  return { lost: Deferred.await(lost) }
})
