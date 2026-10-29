export * as PostgreSQLMigration from "./migration"

import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database"
import { schemaName } from "../schema.sql"
import { baseline } from "./baseline"

// Append new migrations after deployment. Checksums make edits to applied SQL a startup/migration error.
const migrations = [
  { id: "0001_central_postgresql", source: baseline },
  {
    id: "0002_user_role_settings_permissions",
    source: `
ALTER TABLE "__OPENCODE_SCHEMA__"."user" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'member';
--> statement-breakpoint
ALTER TABLE "__OPENCODE_SCHEMA__"."user" ADD COLUMN IF NOT EXISTS "settings_permissions" jsonb;
`,
  },
  {
    id: "0003_user_model",
    source: `
ALTER TABLE "__OPENCODE_SCHEMA__"."user" ADD COLUMN IF NOT EXISTS "model" jsonb;
`,
  },
  {
    id: "0004_project_thumbnail",
    source: `
CREATE TABLE IF NOT EXISTS "__OPENCODE_SCHEMA__"."project_thumbnail" (
	"directory" text PRIMARY KEY,
	"png" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
`,
  },
].map((migration) => ({
  ...migration,
  checksum: createHash("sha256").update(migration.source).digest("hex"),
}))
const schema = sql.identifier(schemaName)
const journal = sql`${schema}.${sql.identifier("schema_migration")}`
const metadata = sql`${schema}.${sql.identifier("instance_metadata")}`
const applicationTables = [
  "workspace",
  "data_migration",
  "account_state",
  "account",
  "control_account",
  "auth_session",
  "credential",
  "event_sequence",
  "event",
  "instance_state",
  "permission",
  "project_directory",
  "project_thumbnail",
  "project",
  "publish_deployment",
  "message",
  "part",
  "session_context_epoch",
  "session_input",
  "session_message",
  "session",
  "todo",
  "session_share",
  "user_state",
  "user",
] as const

const assertRuntimeRole = Effect.fn("PostgreSQLMigration.assertRuntimeRole")(function* (
  db: Database.Client,
  role: string,
) {
  const privileges = yield* db.execute<{ unsafe: boolean }>(sql`
    select exists (
      select 1 from pg_roles
      where (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls
        or rolname in ('pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'))
        and pg_has_role(${role}::name, oid, 'MEMBER')
    ) as unsafe`)
  if (privileges[0]?.unsafe !== false) {
    return yield* Effect.die(
      "The application PostgreSQL role must not be superuser, CREATEDB, CREATEROLE, BYPASSRLS or a member of a privileged role",
    )
  }
  const ddl = yield* db.execute<{ unsafe: boolean }>(sql`
    select has_schema_privilege(${role}::name, oid, 'CREATE')
      or pg_has_role(${role}::name, nspowner, 'MEMBER') as unsafe
    from pg_namespace where nspname = ${schemaName}`)
  if (ddl[0]?.unsafe !== false)
    return yield* Effect.die("The application PostgreSQL role must not own or have CREATE on the instance schema")
  const tables = yield* db.execute<{ unsafe: boolean }>(sql`
    select exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schemaName} and c.relkind in ('r', 'p') and (
        pg_has_role(${role}::name, c.relowner, 'MEMBER')
        or has_table_privilege(${role}::name, c.oid, 'TRUNCATE,REFERENCES,TRIGGER')
        or (c.relname in ('instance_metadata', 'schema_migration')
          and has_table_privilege(${role}::name, c.oid, 'INSERT,UPDATE,DELETE'))
      )
    ) as unsafe`)
  if (tables[0]?.unsafe !== false)
    return yield* Effect.die(
      "The application PostgreSQL role has ownership, DDL or protected metadata write privileges",
    )
})

const execute = Effect.fn("PostgreSQLMigration.execute")(function* (
  db: Database.Client,
  migration: (typeof migrations)[number],
) {
  for (const statement of migration.source
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    yield* db.execute(sql.raw(statement.replaceAll('"__OPENCODE_SCHEMA__"', `"${schemaName}"`)))
  }
  yield* db.execute(
    sql`insert into ${journal} (id, checksum, time_completed) values (${migration.id}, ${migration.checksum}, ${Date.now()})`,
  )
})

const completed = Effect.fn("PostgreSQLMigration.completed")(function* (db: Database.Client) {
  const rows = yield* db.execute<{ id: string; checksum: string }>(sql`select id, checksum from ${journal} order by id`)
  if (
    rows.length > migrations.length ||
    rows.some((row, index) => row.id !== migrations[index].id || row.checksum !== migrations[index].checksum)
  ) {
    return yield* Effect.die("PostgreSQL schema migration version or checksum does not match this application")
  }
  return rows.length
})

const verifyIdentity = Effect.fn("PostgreSQLMigration.verifyIdentity")(function* (
  db: Database.Client,
  instanceID: string,
) {
  const identity = yield* db.execute<{ instance_id: string }>(
    sql`select instance_id from ${metadata} where singleton = true`,
  )
  if (identity.length !== 1 || identity[0].instance_id !== instanceID) {
    return yield* Effect.die("Configured instance identity does not own this PostgreSQL schema")
  }
})

/** A dedicated migrator applies one checksummed PostgreSQL lineage; historical SQLite scripts are never executed. */
export const apply = Effect.fn("PostgreSQLMigration.apply")(function* (
  db: Database.Client,
  input: { readonly instanceID: string },
) {
  if (!input.instanceID.trim()) return yield* Effect.die("An instance identity is required for migration")
  yield* db.transaction(() =>
    Effect.gen(function* () {
      yield* db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`omai:migrate:${schemaName}`}, 0))`)
      yield* db.execute(sql`create schema if not exists ${schema}`)
      const existing = yield* db.execute<{ present: string | null }>(
        sql`select to_regclass(${`${schemaName}.schema_migration`})::text as present`,
      )
      if (!existing[0]?.present) {
        const tables = yield* db.execute<{ count: string }>(
          sql`select count(*)::text as count from information_schema.tables where table_schema = ${schemaName}`,
        )
        if (tables[0]?.count !== "0")
          return yield* Effect.die("Refusing to initialize a non-empty PostgreSQL schema without a migration journal")
        yield* execute(db, migrations[0])
        yield* db.execute(
          sql`insert into ${metadata} (singleton, instance_id, time_created) values (true, ${input.instanceID}, ${Date.now()})`,
        )
      }
      yield* verifyIdentity(db, input.instanceID)
      const count = yield* completed(db)
      for (const migration of migrations.slice(count)) yield* execute(db, migration)
    }),
  )
})

/** Provision only the application's explicit table set. The runtime role never receives schema creation or migration writes. */
export const grantRuntime = Effect.fn("PostgreSQLMigration.grantRuntime")(function* (
  db: Database.Client,
  input: { readonly role: string },
) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.role) || input.role.startsWith("pg_")) {
    return yield* Effect.die("The runtime PostgreSQL role must be a non-system lowercase SQL identifier")
  }
  const role = sql.identifier(input.role)
  const tables = sql.join(
    applicationTables.map((name) => sql`${schema}.${sql.identifier(name)}`),
    sql`, `,
  )
  yield* db.transaction(() =>
    Effect.gen(function* () {
      yield* db.execute(sql`revoke all privileges on schema ${schema} from ${role}`)
      yield* db.execute(sql`grant usage on schema ${schema} to ${role}`)
      yield* db.execute(sql`revoke all privileges on table ${tables}, ${metadata}, ${journal} from ${role}`)
      yield* db.execute(sql`grant select, insert, update, delete on table ${tables} to ${role}`)
      yield* db.execute(sql`grant select on table ${metadata}, ${journal} to ${role}`)
      yield* assertRuntimeRole(db, input.role)
    }),
  )
})

/** Offline import and administration must target the exact migrated instance, even when using the migrator role. */
export const assertMigrated = Effect.fn("PostgreSQLMigration.assertMigrated")(function* (
  db: Database.Client,
  input: { readonly instanceID: string },
) {
  if ((yield* completed(db)) !== migrations.length)
    return yield* Effect.die("PostgreSQL schema is behind this application; run the dedicated migration command")
  yield* verifyIdentity(db, input.instanceID)
})

/** Application startup validates readiness using its restricted role; it never creates or changes schema. */
export const assertReady = Effect.fn("PostgreSQLMigration.assertReady")(function* (
  db: Database.Client,
  input: { readonly instanceID: string },
) {
  const role = yield* db.execute<{ name: string }>(sql`select current_user as name`)
  yield* assertRuntimeRole(db, role[0].name)
  yield* assertMigrated(db, input)
})
