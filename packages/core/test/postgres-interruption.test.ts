import { expect } from "bun:test"
import { createRequire } from "node:module"
import { PgClient } from "@effect/sql-pg"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromConfig(Database.configFromEnvironment()))
// Keep the virtual clock and immediate interrupt: a live timeout or an added yield hides a leaked checkout.
// PgClient's pool close must finish normally after the finalizer's transaction returns its reserved connection.
it.effect("releases a PostgreSQL transaction started by interruption cleanup", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const started = yield* Deferred.make<void>()
    const fiber = yield* Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(db.transaction(() => db.execute(sql`select 1`)).pipe(Effect.orDie)),
      Effect.forkChild,
    )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    expect((yield* db.execute<{ value: number }>(sql`select 1 as value`))[0].value).toBe(1)
  }),
)

type NativePool = Effect.Success<Parameters<typeof PgClient.fromPool>[0]["acquire"]>
// Use the driver's real, exact-version dependency so its checkout counters can
// synchronize acquisition without replacing callbacks or observing private internals.
const driver = createRequire(import.meta.resolve("@effect/sql-pg/package.json"))("pg") as {
  Pool: new (config: { connectionString: string; max: number; connectionTimeoutMillis: number }) => NativePool
}
class Pool extends Context.Service<Pool, NativePool>()("PostgresInterruption.TestPool") {}
const poolLayer = Layer.effect(
  Pool,
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new driver.Pool({
          connectionString: process.env.OPENCODE_DATABASE_URL!,
          max: 2,
          connectionTimeoutMillis: 2000,
        }),
    ),
    (pool) => Effect.promise(() => pool.end()).pipe(Effect.timeoutOption("3 seconds")),
  ),
)
const clientLayer = PgClient.layerFrom(
  Effect.gen(function* () {
    const pool = yield* Pool
    return yield* PgClient.fromPool({ acquire: Effect.succeed(pool) })
  }),
).pipe(Layer.provideMerge(poolLayer))
const native = testEffect(clientLayer)

const waitFor = (condition: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() => (condition() ? Effect.void : Effect.andThen(Effect.yieldNow, waitFor(condition))))

native.live("returns a late checkout after interrupting a saturated pool reservation", () =>
  Effect.gen(function* () {
    const pool = yield* Pool
    const client = yield* PgClient.PgClient
    const first = yield* Scope.make()
    const second = yield* Scope.make()
    yield* Scope.provide(client.reserve, first)
    yield* Scope.provide(client.reserve, second)
    expect(pool.totalCount).toBe(2)
    expect(pool.idleCount).toBe(0)

    const waiter = yield* client.reserve.pipe(Effect.scoped, Effect.forkChild)
    yield* waitFor(() => pool.waitingCount === 1).pipe(Effect.timeout("3 seconds"), Effect.orDie)
    // The synchronous request makes the race ordering explicit: cancellation has
    // happened before a slot becomes available, without waiting for masked acquisition.
    yield* Effect.sync(() => waiter.interruptUnsafe())
    // Interruption is requested while acquisition is queued. Return a real slot;
    // any resulting checkout must register and run its scoped release exactly once.
    yield* Scope.close(first, Exit.void)
    expect(Exit.isFailure(yield* Fiber.await(waiter))).toBe(true)
    yield* Scope.close(second, Exit.void)
    yield* waitFor(() => pool.idleCount === pool.totalCount).pipe(Effect.timeout("3 seconds"), Effect.orDie)
    expect(pool.waitingCount).toBe(0)
    expect(pool.idleCount).toBe(2)
  }),
)
