import { describe, expect } from "bun:test"
import { randomBytes } from "node:crypto"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "../src/database/database"
import { DataKeyRotation } from "../src/database/postgres/rotate-data-key"
import { schemaName } from "../src/database/schema.sql"
import { InstanceStateEncryption } from "../src/instance-state/encryption"
import { testEffect } from "./lib/effect"

const source = InstanceStateEncryption.keyFromEnvironment()
const target = { instanceID: source.instanceID, secret: randomBytes(32).toString("base64") }
const oldCodec = InstanceStateEncryption.codec(source)
const newCodec = InstanceStateEncryption.codec(target)
const table = (name: string) => sql`${sql.identifier(schemaName)}.${sql.identifier(name)}`
const it = testEffect(Database.layerFromConfig(Database.configFromEnvironment()))

const seed = Effect.gen(function* () {
  const database = yield* Database.Service
  const state = Array.from(
    { length: 105 },
    (_, index) =>
      sql`(${"rotation-test"}, ${String(index).padStart(3, "0")}, ${oldCodec.encode("rotation-test", String(index).padStart(3, "0"), { index, value: "private-state" })}, 1, 1)`,
  )
  yield* database.db.execute(
    sql`insert into ${table("instance_state")} (namespace, key, value, revision, time_updated) values ${sql.join(state, sql`, `)}`,
  )
  yield* database.db.execute(
    sql`insert into ${table("credential")} (id, label, value, time_created, time_updated) values (${"credential-test"}, ${"test"}, ${oldCodec.encode("credential", "value", { type: "api", key: "private-api-key" })}, 1, 1)`,
  )
  yield* database.db.execute(
    sql`insert into ${table("account")} (id, email, url, access_token, refresh_token, time_created, time_updated) values (${"account-test"}, ${"test@example.invalid"}, ${"https://example.invalid"}, ${oldCodec.encode("account", "access_token", "private-account-access")}, ${oldCodec.encode("account", "refresh_token", "private-account-refresh")}, 1, 1)`,
  )
  yield* database.db.execute(
    sql`insert into ${table("control_account")} (email, url, access_token, refresh_token, active, time_created, time_updated) values (${"test@example.invalid"}, ${"https://example.invalid"}, ${oldCodec.encode("control_account", "access_token", "private-control-access")}, ${oldCodec.encode("control_account", "refresh_token", "private-control-refresh")}, false, 1, 1)`,
  )
  yield* database.db.execute(
    sql`insert into ${table("project")} (id, worktree, sandboxes, time_created, time_updated) values (${"project-test"}, ${"/test/project"}, ${"[]"}, 1, 1)`,
  )
  yield* database.db.execute(
    sql`insert into ${table("session")} (id, project_id, slug, directory, title, version, time_created, time_updated) values (${"session-test"}, ${"project-test"}, ${"test"}, ${"/test/project"}, ${"test"}, ${"test"}, 1, 1)`,
  )
  yield* database.db.execute(
    sql`insert into ${table("session_share")} (session_id, id, secret, url, time_created, time_updated) values (${"session-test"}, ${"share-test"}, ${oldCodec.encode("session_share", "secret", "private-share-secret")}, ${"https://example.invalid/share"}, 1, 1)`,
  )
})

const snapshot = Effect.gen(function* () {
  const database = yield* Database.Service
  return {
    state: yield* database.db.execute<{ namespace: string; key: string; value: string }>(
      sql`select namespace, key, value from ${table("instance_state")} order by namespace, key`,
    ),
    credential: yield* database.db.execute<{ value: string }>(
      sql`select value from ${table("credential")} order by id`,
    ),
    account: yield* database.db.execute<{ access_token: string; refresh_token: string }>(
      sql`select access_token, refresh_token from ${table("account")} order by id`,
    ),
    control: yield* database.db.execute<{ access_token: string; refresh_token: string }>(
      sql`select access_token, refresh_token from ${table("control_account")} order by email, url`,
    ),
    share: yield* database.db.execute<{ secret: string }>(
      sql`select secret from ${table("session_share")} order by session_id`,
    ),
  }
})

describe("offline data key rotation", () => {
  it.live("validates every encrypted column without changing ciphertext by default", () =>
    Effect.gen(function* () {
      yield* seed
      const database = yield* Database.Service
      const before = yield* snapshot
      const report = yield* DataKeyRotation.run(database.db, { source, target, apply: false })
      expect(report.applied).toBe(false)
      expect(report.rows).toEqual({
        instance_state: 105,
        credential: 1,
        account: 1,
        control_account: 1,
        session_share: 1,
      })
      expect(yield* snapshot).toEqual(before)
    }),
  )

  it.live("rotates all columns and multiple batches atomically and records an encrypted journal", () =>
    Effect.gen(function* () {
      yield* seed
      const database = yield* Database.Service
      const report = yield* DataKeyRotation.run(database.db, { source, target, apply: true })
      const rotated = yield* snapshot
      expect(rotated.state).toHaveLength(106)
      for (const row of rotated.state) {
        const value = newCodec.decode(row.namespace, row.key, row.value)
        expect(() => oldCodec.decode(row.namespace, row.key, row.value)).toThrow()
        if (row.namespace === "key-rotation") expect(value).toEqual(report)
        else expect(value).toEqual({ index: Number(row.key), value: "private-state" })
      }
      expect(newCodec.decode("credential", "value", rotated.credential[0].value)).toEqual({
        type: "api",
        key: "private-api-key",
      })
      expect(newCodec.decode("account", "access_token", rotated.account[0].access_token)).toBe("private-account-access")
      expect(newCodec.decode("account", "refresh_token", rotated.account[0].refresh_token)).toBe(
        "private-account-refresh",
      )
      expect(newCodec.decode("control_account", "access_token", rotated.control[0].access_token)).toBe(
        "private-control-access",
      )
      expect(newCodec.decode("control_account", "refresh_token", rotated.control[0].refresh_token)).toBe(
        "private-control-refresh",
      )
      expect(newCodec.decode("session_share", "secret", rotated.share[0].secret)).toBe("private-share-secret")
      expect(() => oldCodec.decode("credential", "value", rotated.credential[0].value)).toThrow()
      yield* DataKeyRotation.run(database.db, { source: target, target: source, apply: true })
      const restored = yield* snapshot
      expect(oldCodec.decode("credential", "value", restored.credential[0].value)).toEqual({
        type: "api",
        key: "private-api-key",
      })
      expect(() => newCodec.decode("credential", "value", restored.credential[0].value)).toThrow()
    }),
  )

  it.live("rolls back every earlier table when a later ciphertext is corrupt", () =>
    Effect.gen(function* () {
      yield* seed
      const database = yield* Database.Service
      yield* database.db.execute(sql`update ${table("account")} set refresh_token = ${"corrupt-ciphertext"}`)
      const before = yield* snapshot
      const result = yield* DataKeyRotation.run(database.db, { source, target, apply: true }).pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
      )
      expect(result).toMatchObject({
        _tag: "DataKeyRotation.Error",
        operation: "decrypt-and-reencrypt",
        table: "account",
      })
      expect(yield* snapshot).toEqual(before)
    }),
  )

  it.live("refuses to rotate while an application owns the PostgreSQL runtime", () =>
    Effect.gen(function* () {
      yield* seed
      const database = yield* Database.Service
      yield* Database.claimRuntime(database.db, source.instanceID)
      const before = yield* snapshot
      const result = yield* DataKeyRotation.run(database.db, { source, target, apply: true }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* snapshot).toEqual(before)
    }),
  )
})
