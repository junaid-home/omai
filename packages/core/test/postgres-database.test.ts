import { describe, expect, test } from "bun:test"
import { SQL } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Scope } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { PostgreSQLMigration } from "../src/database/postgres/migration"
import { schemaName } from "../src/database/schema.sql"
import { UserTable } from "../src/user/sql"
import { CredentialTable } from "../src/credential/sql"
import { Credential } from "../src/credential"
import { Integration } from "@opencode-ai/schema/integration"

const config = () => Database.configFromEnvironment()
const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromConfig(config())), Effect.scoped))
const user = (id: string) => ({
  id,
  username: id,
  email: `${id}@example.test`,
  password_hash: "test-only-existing-hash",
})

describe("native PostgreSQL database contract", () => {
  test("preserves the complete instance schema and the deployment lookup index", () =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db.execute<{ tablename: string }>(
          sql`select tablename from pg_tables where schemaname = ${schemaName}`,
        )
        expect(rows.map((row) => row.tablename)).toContain("user")
        expect(rows.map((row) => row.tablename)).toContain("publish_deployment")
        expect(rows.map((row) => row.tablename)).toContain("message")
        expect(rows.map((row) => row.tablename)).toContain("session_message")
        expect(rows.map((row) => row.tablename)).toContain("instance_state")
        const indices = yield* db.execute<{ indexname: string }>(
          sql`select indexname from pg_indexes where schemaname = ${schemaName} and indexname = 'publish_deployment_project_idx'`,
        )
        expect(indices).toHaveLength(1)
      }),
    ))

  test("captured root database writes share the reserved transaction and roll back together", () =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const result = yield* db
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.insert(UserTable).values(user("rollback_root"))
              expect(yield* db.select().from(UserTable)).toHaveLength(1)
              return yield* Effect.fail("deliberate rollback")
            }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* db.select().from(UserTable)).toHaveLength(0)
      }),
    ))

  test("nested transactions use savepoints without losing the outer root-client transaction", () =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db.insert(UserTable).values(user("outer_before"))
            const nested = yield* db
              .transaction(() =>
                Effect.gen(function* () {
                  yield* db.insert(UserTable).values(user("nested_rollback"))
                  return yield* Effect.fail("rollback nested")
                }),
              )
              .pipe(Effect.exit)
            expect(Exit.isFailure(nested)).toBe(true)
            yield* db.insert(UserTable).values(user("outer_after"))
          }),
        )
        expect(
          (yield* db.select({ id: UserTable.id }).from(UserTable).orderBy(UserTable.id)).map((row) => row.id),
        ).toEqual(["outer_after", "outer_before"])
      }),
    ))

  test("maps absent singular results and rejects unsafe integer writes", () =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(yield* db.select().from(UserTable).pipe(Database.first)).toBeUndefined()
        const result = yield* Effect.suspend(() =>
          db.insert(UserTable).values({ ...user("overflow"), time_created: Number.MAX_SAFE_INTEGER + 1 }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(String(result)).toContain("safe integer")
        expect(yield* db.select().from(UserTable)).toHaveLength(0)
      }),
    ))

  test("encrypts credentials before SQL and decrypts through the native column codec", () =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const id = Credential.ID.create()
        const value: Credential.Value = { type: "key", key: "provider-secret-must-not-be-in-database" }
        yield* db
          .insert(CredentialTable)
          .values({ id, integration_id: Integration.ID.make("test-provider"), label: "test", value })
        const stored = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).pipe(Database.first)
        expect(stored?.value).toEqual(value)
        const raw = yield* db.execute<{ value: string }>(
          sql`select value from ${sql.identifier(schemaName)}.credential where id = ${id}`,
        )
        expect(raw[0].value).toStartWith("v1.")
        expect(raw[0].value).not.toContain("provider-secret")
      }),
    ))

  test("accepts an existing migration idempotently and rejects another instance binding", async () => {
    await Effect.runPromise(
      Database.Service.use(({ db }) =>
        Effect.gen(function* () {
          yield* PostgreSQLMigration.apply(db, { instanceID: config().instanceID })
          yield* PostgreSQLMigration.apply(db, { instanceID: config().instanceID })
          const result = yield* PostgreSQLMigration.apply(db, { instanceID: "wrong-instance" }).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          expect(String(result)).toContain("does not own")
        }),
      ).pipe(
        Effect.provide(
          Database.layerFromConfig({ ...config(), url: process.env.OMAI_TEST_DATABASE_URL!, mode: "migration" }),
        ),
        Effect.scoped,
      ),
    )
  })

  test("rejects a privileged role for application startup", async () => {
    const result = await Effect.runPromise(
      Database.Service.use(() => Effect.void).pipe(
        Effect.provide(Database.layerFromConfig({ ...config(), url: process.env.OMAI_TEST_DATABASE_URL! })),
        Effect.scoped,
        Effect.exit,
      ),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(String(result)).toContain("must not be superuser")
  })

  test("provisions only runtime privileges and rejects schema creation or migration journal writes", async () => {
    const current = config()
    const role = new URL(current.url).username
    const startup = Database.Service.use(() => Effect.void).pipe(
      Effect.provide(Database.layerFromConfig(current)),
      Effect.scoped,
      Effect.exit,
    )
    await Effect.runPromise(
      Database.Service.use(({ db }) =>
        Effect.gen(function* () {
          yield* db.execute(sql`grant create on schema ${sql.identifier(schemaName)} to ${sql.identifier(role)}`)
          const schemaAccess = yield* startup
          expect(Exit.isFailure(schemaAccess)).toBe(true)
          expect(String(schemaAccess)).toContain("CREATE on the instance schema")
          yield* PostgreSQLMigration.grantRuntime(db, { role })
          expect(Exit.isSuccess(yield* startup)).toBe(true)
          yield* db.execute(
            sql`grant update on table ${sql.identifier(schemaName)}.schema_migration to ${sql.identifier(role)}`,
          )
          const journalAccess = yield* startup
          expect(Exit.isFailure(journalAccess)).toBe(true)
          expect(String(journalAccess)).toContain("protected metadata write privileges")
        }).pipe(Effect.ensuring(PostgreSQLMigration.grantRuntime(db, { role }).pipe(Effect.orDie))),
      ).pipe(
        Effect.provide(
          Database.layerFromConfig({ ...current, url: process.env.OMAI_TEST_DATABASE_URL!, mode: "migration" }),
        ),
        Effect.scoped,
      ),
    )
  })

  test("loads mounted URL secrets and rejects ambiguous direct configuration", () => {
    const direct = process.env.OPENCODE_DATABASE_MIGRATOR_URL
    const file = process.env.OPENCODE_DATABASE_MIGRATOR_URL_FILE
    const directory = mkdtempSync(join(tmpdir(), "omai-db-secret-"))
    const path = join(directory, "connection")
    try {
      delete process.env.OPENCODE_DATABASE_MIGRATOR_URL
      writeFileSync(path, "postgresql://example.invalid/instance\n", { mode: 0o600 })
      process.env.OPENCODE_DATABASE_MIGRATOR_URL_FILE = path
      expect(Database.connectionURLFromEnvironment("OPENCODE_DATABASE_MIGRATOR_URL")).toBe(
        "postgresql://example.invalid/instance",
      )
      process.env.OPENCODE_DATABASE_MIGRATOR_URL = "postgresql://another.invalid/instance"
      expect(() => Database.connectionURLFromEnvironment("OPENCODE_DATABASE_MIGRATOR_URL")).toThrow("Configure only")
      delete process.env.OPENCODE_DATABASE_MIGRATOR_URL
      writeFileSync(path, "\n")
      expect(() => Database.connectionURLFromEnvironment("OPENCODE_DATABASE_MIGRATOR_URL")).toThrow("non-empty")
    } finally {
      if (direct === undefined) delete process.env.OPENCODE_DATABASE_MIGRATOR_URL
      else process.env.OPENCODE_DATABASE_MIGRATOR_URL = direct
      if (file === undefined) delete process.env.OPENCODE_DATABASE_MIGRATOR_URL_FILE
      else process.env.OPENCODE_DATABASE_MIGRATOR_URL_FILE = file
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a dedicated non-superuser migrator creates its schema and grants only application access", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "")
    const database = `omai_test_migration_${suffix}`
    const migrator = `omai_test_migrator_${suffix}`
    const runtime = `omai_test_runtime_${suffix}`
    const password = crypto.randomUUID().replaceAll("-", "")
    const admin = new SQL(process.env.OMAI_TEST_DATABASE_URL!, { max: 1 })
    const url = new URL(process.env.OMAI_TEST_DATABASE_URL!)
    url.pathname = `/${database}`
    url.password = password
    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`)
      await admin.unsafe(
        `CREATE ROLE "${migrator}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password}'`,
      )
      await admin.unsafe(
        `CREATE ROLE "${runtime}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password}'`,
      )
      await admin.unsafe(`GRANT CONNECT, CREATE ON DATABASE "${database}" TO "${migrator}"`)
      url.username = migrator
      await Effect.runPromise(
        Database.Service.use(({ db }) =>
          Effect.gen(function* () {
            yield* PostgreSQLMigration.apply(db, { instanceID: config().instanceID })
            yield* PostgreSQLMigration.grantRuntime(db, { role: runtime })
            const owner = yield* db.execute<{ name: string }>(
              sql`select pg_get_userbyid(nspowner) as name from pg_namespace where nspname = ${schemaName}`,
            )
            expect(owner[0]?.name).toBe(migrator)
          }),
        ).pipe(
          Effect.provide(Database.layerFromConfig({ ...config(), url: url.toString(), mode: "migration" })),
          Effect.scoped,
        ),
      )
      url.username = runtime
      await Effect.runPromise(
        Database.Service.use(({ db }) =>
          Effect.gen(function* () {
            yield* db.insert(UserTable).values(user("restricted_migration"))
            expect(yield* db.select().from(UserTable)).toHaveLength(1)
            const privileges = yield* db.execute<{ create: boolean; journal_write: boolean }>(sql`
          select has_schema_privilege(current_user, ${schemaName}, 'CREATE') as create,
            has_table_privilege(current_user, ${`${schemaName}.schema_migration`}, 'INSERT,UPDATE,DELETE,TRUNCATE') as journal_write`)
            expect(privileges[0]).toEqual({ create: false, journal_write: false })
          }),
        ).pipe(Effect.provide(Database.layerFromConfig({ ...config(), url: url.toString() })), Effect.scoped),
      )
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      await admin.unsafe(`DROP ROLE IF EXISTS "${runtime}"`)
      await admin.unsafe(`DROP ROLE IF EXISTS "${migrator}"`)
      await admin.close()
    }
  })

  test(
    "runtime ownership signals loss after its dedicated PostgreSQL connection dies",
    () =>
      run(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const ownership = yield* Database.claimRuntime(db, config().instanceID)
          const key = `omai:runtime:${schemaName}:${config().instanceID}`
          const owner = yield* db.execute<{ pid: number }>(
            sql`select pid from pg_locks where locktype = 'advisory' and granted and classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid and objid = (hashtextextended(${key}, 0) & 4294967295)::oid and objsubid = 1`,
          )
          expect(owner).toHaveLength(1)
          yield* db.execute(sql`select pg_terminate_backend(${owner[0].pid})`)
          const lost = yield* ownership.lost.pipe(Effect.timeout("7 seconds"), Effect.exit)
          expect(Exit.isFailure(lost)).toBe(true)
          expect(String(lost)).toContain("RuntimeOwnershipLost")
        }),
      ),
    10_000,
  )

  test("dedicated runtime ownership excludes a second claimant and releases with its scope", () =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Database.claimRuntime(db, config().instanceID)
            const second = yield* Effect.scoped(Database.claimRuntime(db, config().instanceID)).pipe(Effect.exit)
            expect(Exit.isFailure(second)).toBe(true)
            expect(String(second)).toContain("already owns")
          }),
        )
        yield* Effect.scoped(Database.claimRuntime(db, config().instanceID))
      }),
    ))

  test("interrupted runtime ownership acquisition releases a server-acquired lock", async () => {
    const admin = new SQL(process.env.OMAI_TEST_DATABASE_URL!, { max: 1 })
    const barrier = `omai:ownership-test:${crypto.randomUUID()}`
    const key = `omai:runtime:${schemaName}:${config().instanceID}`
    try {
      await admin`select pg_advisory_lock(hashtextextended(${barrier}, 0))`
      // Hold the real query after PostgreSQL has acquired the session lock, before
      // its result can reach the caller. Session locks survive query cancellation.
      await admin.unsafe(`
        create function "${schemaName}".pg_try_advisory_lock(bigint) returns boolean
        language plpgsql as $$
        declare acquired boolean;
        begin
          acquired := pg_catalog.pg_try_advisory_lock($1);
          perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('${barrier}', 0));
          return acquired;
        end $$`)
      await run(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const acquired = db.execute<{ count: string }>(sql`
            select count(*)::text as count from pg_locks
            where locktype = 'advisory' and granted
              and classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
              and objid = (hashtextextended(${key}, 0) & 4294967295)::oid and objsubid = 1`)
          const claimant = yield* Database.claimRuntime(db, config().instanceID).pipe(Effect.scoped, Effect.forkChild)
          const wait = (): Effect.Effect<void, Effect.Error<typeof acquired>> =>
            acquired.pipe(
              Effect.flatMap((rows) =>
                rows[0]?.count === "1" ? Effect.void : Effect.andThen(Effect.yieldNow, Effect.suspend(wait)),
              ),
            )
          yield* wait().pipe(Effect.timeout("5 seconds"))
          yield* Fiber.interrupt(claimant)
          expect((yield* acquired)[0]?.count).toBe("0")
        }),
      )
    } finally {
      await admin.unsafe(`drop function if exists "${schemaName}".pg_try_advisory_lock(bigint)`)
      await admin`select pg_advisory_unlock(hashtextextended(${barrier}, 0))`
      await admin.close()
    }
  }, 10_000)
})
