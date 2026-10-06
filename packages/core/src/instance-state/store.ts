import { InstanceStateEncryption } from "./encryption"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { InstanceStateTable } from "./sql"

export class StateError extends Schema.TaggedErrorClass<StateError>()("InstanceStateStore.Error", {
  operation: Schema.String,
  namespace: Schema.String,
}) {}

export interface Interface {
  readonly read: (namespace: string, key: string) => Effect.Effect<unknown | undefined, StateError>
  readonly keys: (namespace: string) => Effect.Effect<ReadonlyArray<string>, StateError>
  readonly update: <A, E>(
    namespace: string,
    key: string,
    change: (value: unknown | undefined) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | StateError>
  readonly write: (namespace: string, key: string, value: unknown) => Effect.Effect<void, StateError>
  readonly remove: (namespace: string, key: string) => Effect.Effect<void, StateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStateStore") {}

export const layerFromKey = (input: InstanceStateEncryption.Key) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const encryption = InstanceStateEncryption.codec(input)
      const fail = (operation: string, namespace: string) => new StateError({ operation, namespace })
      const where = (namespace: string, key: string) =>
        and(eq(InstanceStateTable.namespace, namespace), eq(InstanceStateTable.key, key))
      const read = Effect.fn("InstanceStateStore.read")(function* (namespace: string, key: string) {
        const row = yield* db
          .select({ value: InstanceStateTable.value })
          .from(InstanceStateTable)
          .where(where(namespace, key))
          .pipe(
            Database.first,
            Effect.mapError(() => fail("read", namespace)),
          )
        if (!row) return undefined
        return yield* Effect.try({
          try: () => encryption.decode(namespace, key, row.value),
          catch: () => fail("decrypt", namespace),
        })
      })

      const update: Interface["update"] = (namespace, key, change) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              // The lock also serializes absent rows, which SELECT FOR UPDATE alone cannot do.
              yield* db
                .execute(
                  sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["instance-state", namespace, key])}, 0))`,
                )
                .pipe(Effect.mapError(() => fail("lock", namespace)))
              const next = yield* change(yield* read(namespace, key))
              if (next === undefined) {
                yield* db
                  .delete(InstanceStateTable)
                  .where(where(namespace, key))
                  .pipe(Effect.mapError(() => fail("delete", namespace)))
                return next
              }
              const value = yield* Effect.try({
                try: () => encryption.encode(namespace, key, next),
                catch: () => fail("encrypt", namespace),
              })
              yield* db
                .insert(InstanceStateTable)
                .values({ namespace, key, value, revision: 1, time_updated: Date.now() })
                .onConflictDoUpdate({
                  target: [InstanceStateTable.namespace, InstanceStateTable.key],
                  set: {
                    value,
                    revision: sql`${InstanceStateTable.revision} + 1`,
                    time_updated: Date.now(),
                  },
                })
                .pipe(Effect.mapError(() => fail("write", namespace)))
              return next
            }),
          )
          .pipe(Effect.catchTag("SqlError", () => Effect.fail(fail("transaction", namespace))))

      return Service.of({
        read,
        update,
        keys: (namespace) =>
          db
            .select({ key: InstanceStateTable.key })
            .from(InstanceStateTable)
            .where(eq(InstanceStateTable.namespace, namespace))
            .pipe(
              Effect.map((rows) => rows.map((row) => row.key)),
              Effect.mapError(() => fail("list", namespace)),
            ),
        write: (namespace, key, value) => update(namespace, key, () => Effect.succeed(value)).pipe(Effect.asVoid),
        remove: (namespace, key) => update(namespace, key, () => Effect.succeed(undefined)).pipe(Effect.asVoid),
      })
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.suspend(() => layerFromKey(InstanceStateEncryption.keyFromEnvironment())),
  deps: [Database.node],
})

export * as InstanceStateStore from "./store"
