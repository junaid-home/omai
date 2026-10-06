import { afterAll, describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "../src/database/database"
import { InstanceStateEncryption } from "../src/instance-state/encryption"
import { InstanceStateStore } from "../src/instance-state/store"
import { InstanceStateTable } from "../src/instance-state/sql"

const key = InstanceStateEncryption.keyFromEnvironment()
const create = () =>
  ManagedRuntime.make(
    InstanceStateStore.layerFromKey(key).pipe(
      Layer.provideMerge(Database.layerFromConfig(Database.configFromEnvironment())),
    ),
  )
const first = create()
const second = create()
afterAll(() => Promise.all([first.dispose(), second.dispose()]))

describe("encrypted instance state", () => {
  test("serializes absent-row updates across independent PostgreSQL pools", async () => {
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 ? first : second).runPromise(
          Effect.gen(function* () {
            const store = yield* InstanceStateStore.Service
            yield* store.update("test-counter", "counter", (value) =>
              Effect.succeed((typeof value === "number" ? value : 0) + 1),
            )
          }),
        ),
      ),
    )
    expect(
      await first.runPromise(
        Effect.gen(function* () {
          const store = yield* InstanceStateStore.Service
          return yield* store.read("test-counter", "counter")
        }),
      ),
    ).toBe(24)
  })

  test("rolls back nested key writes when their enclosing update fails", async () => {
    await first.runPromise(
      Effect.gen(function* () {
        const store = yield* InstanceStateStore.Service
        yield* store.write("test-atomic", "source", { status: "available" })
        const result = yield* store
          .update("test-atomic", "source", () =>
            Effect.gen(function* () {
              yield* store.write("test-atomic", "destination", { status: "issued" })
              return yield* Effect.fail("exchange failed")
            }),
          )
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => "unexpected" }))
        expect(result).toBe("exchange failed")
        expect(yield* store.read("test-atomic", "source")).toEqual({ status: "available" })
        expect(yield* store.read("test-atomic", "destination")).toBeUndefined()
      }),
    )
  })

  test("stores authenticated ciphertext bound to instance, namespace and key", async () => {
    await first.runPromise(
      Effect.gen(function* () {
        const store = yield* InstanceStateStore.Service
        const database = yield* Database.Service
        const secret = { access: "test-private-access-token", refresh: "test-private-refresh-token" }
        yield* store.write("test-secret", "first", secret)
        yield* store.write("test-secret", "second", secret)
        const rows = yield* database.db
          .select()
          .from(InstanceStateTable)
          .where(eq(InstanceStateTable.namespace, "test-secret"))
        expect(rows).toHaveLength(2)
        expect(rows[0].value).not.toEqual(rows[1].value)
        for (const row of rows) {
          expect(row.value.startsWith("v1.")).toBe(true)
          expect(row.value).not.toContain(secret.access)
          expect(row.value).not.toContain(secret.refresh)
        }
        const firstRow = rows.find((row) => row.key === "first")!
        expect(() =>
          InstanceStateEncryption.codec({ ...key, instanceID: `${key.instanceID}-other` }).decode(
            "test-secret",
            "first",
            firstRow.value,
          ),
        ).toThrow()
        yield* database.db
          .update(InstanceStateTable)
          .set({ value: firstRow.value })
          .where(and(eq(InstanceStateTable.namespace, "test-secret"), eq(InstanceStateTable.key, "second")))
        const rejected = yield* store
          .read("test-secret", "second")
          .pipe(Effect.match({ onFailure: (error) => error.operation, onSuccess: () => "unexpected" }))
        expect(rejected).toBe("decrypt")
        expect(yield* store.read("test-secret", "first")).toEqual(secret)
      }),
    )
  })
})
