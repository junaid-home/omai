export * as TestDatabase from "./database"

import { SQL } from "bun"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { PostgreSQLMigration } from "@opencode-ai/core/database/postgres/migration"
import { schemaName } from "@opencode-ai/core/database/schema.sql"

function sourceURL() {
  const value = process.env.OMAI_TEST_DATABASE_URL
  if (!value) throw new Error("OMAI_TEST_DATABASE_URL must explicitly identify a disposable test database")
  const url = new URL(value)
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Tests require a real PostgreSQL URL")
  return url
}

function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid generated test database identifier")
  return `"${value}"`
}

/** Provision only a random test namespace. The administrator connection never enters Database.Service. */
export async function create(input: { database?: string; instanceID?: string } = {}) {
  if (!schemaName.startsWith("omai_test_")) throw new Error("Refusing to provision or truncate a non-test schema")
  const source = sourceURL()
  const admin = new SQL(source.toString(), { max: 1 })
  const instanceID = input.instanceID ?? process.env.OPENCODE_INSTANCE_ID!
  const role = `omai_test_role_${crypto.randomUUID().replaceAll("-", "")}`
  const password = crypto.randomUUID().replaceAll("-", "")
  const target = new URL(source)
  if (input.database) {
    await admin.unsafe(`CREATE DATABASE ${identifier(input.database)}`)
    target.pathname = `/${input.database}`
  }
  const connection = new SQL(target.toString(), { max: 1 })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await connection.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schemaName)} CASCADE`)
    await connection.close()
    if (input.database) await admin.unsafe(`DROP DATABASE ${identifier(input.database)} WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${identifier(role)}`)
    await admin.close()
  }
  try {
    await Effect.runPromise(
      Database.Service.use(({ db }) => PostgreSQLMigration.apply(db, { instanceID })).pipe(
        Effect.provide(Database.layerFromConfig({ url: target.toString(), instanceID, mode: "migration" })),
        Effect.scoped,
      ),
    )
    await connection.unsafe(`CREATE TABLE ${identifier(schemaName)}.event_commit_probe (value text NOT NULL)`)
    await admin.unsafe(`CREATE ROLE ${identifier(role)} LOGIN PASSWORD '${password}'`)
    await connection.unsafe(`GRANT USAGE ON SCHEMA ${identifier(schemaName)} TO ${identifier(role)}`)
    await connection.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${identifier(schemaName)} TO ${identifier(role)}`,
    )
    await connection.unsafe(
      `REVOKE INSERT, UPDATE, DELETE ON ${identifier(schemaName)}.instance_metadata, ${identifier(schemaName)}.schema_migration FROM ${identifier(role)}`,
    )
    target.username = role
    target.password = password
    return {
      url: target.toString(),
      instanceID,
      close,
      async reset() {
        const rows = await connection<{ tablename: string }[]>`
          SELECT tablename FROM pg_tables
          WHERE schemaname = ${schemaName}
            AND tablename NOT IN ('instance_metadata', 'schema_migration')
          ORDER BY tablename
        `
        if (rows.length) {
          const names = rows.map((row) => `${identifier(schemaName)}.${identifier(row.tablename)}`).join(", ")
          await connection.unsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`)
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

/** A second physical test database is necessary because native Drizzle schemas are statically bound. */
export const isolatedLayer = () =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.promise(() => create({ database: `omai_test_db_${crypto.randomUUID().replaceAll("-", "")}` })),
      (database) => Effect.promise(() => database.close()),
    ).pipe(Effect.map((database) => Database.layerFromConfig({ url: database.url, instanceID: database.instanceID }))),
  )
