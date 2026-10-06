import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Authentication } from "../src/authentication"
import { Database } from "../src/database/database"
import { UserState } from "../src/user-state"
import { UserTable } from "../src/user/sql"

const principal = (name: string): Authentication.Principal => ({
  userID: crypto.randomUUID(),
  sessionID: crypto.randomUUID(),
  instanceID: process.env.OPENCODE_INSTANCE_ID ?? "user-state-test",
  username: `state-${name}-${crypto.randomUUID()}`,
  email: `${name}-${crypto.randomUUID()}@example.invalid`,
})

const alice = principal("alice")
const bob = principal("bob")
// Independent pools exercise database arbitration, not a JavaScript mutex.
const first = ManagedRuntime.make(
  UserState.layer.pipe(Layer.provideMerge(Database.layerFromConfig(Database.configFromEnvironment()))),
)
const second = ManagedRuntime.make(
  UserState.layer.pipe(Layer.provideMerge(Database.layerFromConfig(Database.configFromEnvironment()))),
)

function read(input: UserState.Query, user = alice) {
  return Effect.gen(function* () {
    const state = yield* UserState.Service
    return yield* state.get(input)
  }).pipe(Effect.provideService(Authentication.Current, user))
}

function write(input: UserState.Write, user = alice) {
  return Effect.gen(function* () {
    const state = yield* UserState.Service
    return yield* state.put(input)
  }).pipe(Effect.provideService(Authentication.Current, user))
}

beforeEach(async () => {
  await first.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.insert(UserTable).values(
        [alice, bob].map((user) => ({
          id: user.userID,
          username: user.username,
          email: user.email,
          password_hash: "not-a-login-credential",
        })),
      )
    }),
  )
})

afterAll(async () => {
  await Promise.all([first.dispose(), second.dispose()])
})

describe("central user state", () => {
  test("reads another pool's committed state", async () => {
    const key = { namespace: "preferences", key: crypto.randomUUID() } as const
    expect(await first.runPromise(read(key))).toEqual({ revision: 0, value: null })
    expect(await first.runPromise(write({ ...key, expectedRevision: 0, value: '{"theme":"dark"}' }))).toEqual({
      revision: 1,
      value: '{"theme":"dark"}',
    })
    expect(await second.runPromise(read(key))).toEqual({ revision: 1, value: '{"theme":"dark"}' })
  })

  test("arbitrates concurrent creates and updates across independent pools", async () => {
    const key = { namespace: "drafts", key: crypto.randomUUID() } as const
    const create = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        (index % 2 ? first : second).runPromise(
          write({ ...key, expectedRevision: 0, value: String(index) }).pipe(
            Effect.match({
              onFailure: (error) => ({ success: false, error }),
              onSuccess: (snapshot) => ({ success: true, snapshot }),
            }),
          ),
        ),
      ),
    )
    expect(create.filter((result) => result.success)).toHaveLength(1)
    for (const result of create) {
      if (!("error" in result)) continue
      expect(result.error).toBeInstanceOf(UserState.Conflict)
      if (result.error instanceof UserState.Conflict) expect(result.error.current.revision).toBe(1)
    }
    const update = await Promise.all(
      [first, second].map((runtime, index) =>
        runtime.runPromise(
          write({ ...key, expectedRevision: 1, value: `update-${index}` }).pipe(
            Effect.match({ onFailure: (error) => error, onSuccess: (snapshot) => snapshot }),
          ),
        ),
      ),
    )
    expect(update.filter((result) => result instanceof UserState.Conflict)).toHaveLength(1)
    expect(await first.runPromise(read(key))).toMatchObject({ revision: 2 })
  })

  test("retains tombstones and rejects stale recreation and stale updates", async () => {
    const key = { namespace: "comments", key: crypto.randomUUID() } as const
    expect(await first.runPromise(write({ ...key, expectedRevision: 0, value: null }))).toEqual({
      revision: 1,
      value: null,
    })
    expect(
      await second.runPromise(
        write({ ...key, expectedRevision: 0, value: "stale" }).pipe(
          Effect.catchTag("UserState.Conflict", (error) => Effect.succeed(error.current)),
        ),
      ),
    ).toEqual({ revision: 1, value: null })
    expect(await second.runPromise(write({ ...key, expectedRevision: 1, value: "restored" }))).toEqual({
      revision: 2,
      value: "restored",
    })
    expect(await first.runPromise(write({ ...key, expectedRevision: 2, value: null }))).toEqual({
      revision: 3,
      value: null,
    })
    expect(
      await second.runPromise(
        write({ ...key, expectedRevision: 2, value: "stale" }).pipe(
          Effect.catchTag("UserState.Conflict", (error) => Effect.succeed(error.current)),
        ),
      ),
    ).toEqual({ revision: 3, value: null })
  })

  test("scopes identical namespaces and keys to the authenticated user", async () => {
    const key = { namespace: "history", key: crypto.randomUUID() } as const
    await first.runPromise(write({ ...key, expectedRevision: 0, value: "alice-private" }, alice))
    expect(await second.runPromise(read(key, bob))).toEqual({ revision: 0, value: null })
    await second.runPromise(write({ ...key, expectedRevision: 0, value: "bob-private" }, bob))
    expect(await first.runPromise(read(key, alice))).toEqual({ revision: 1, value: "alice-private" })
    expect(await first.runPromise(read(key, bob))).toEqual({ revision: 1, value: "bob-private" })
  })

  test("rejects reads and writes without a request principal", async () => {
    const key = { namespace: "ui", key: crypto.randomUUID() } as const
    const denied = await first.runPromise(
      Effect.gen(function* () {
        const state = yield* UserState.Service
        return yield* Effect.all([
          state.get(key).pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "unexpected" })),
          state
            .put({ ...key, expectedRevision: 0, value: "denied" })
            .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "unexpected" })),
        ])
      }),
    )
    expect(denied).toEqual(["UserState.Unauthenticated", "UserState.Unauthenticated"])
  })

  test("validates UTF-8 byte limits, PostgreSQL text safety, and revision bounds", async () => {
    const key = { namespace: "workspace", key: crypto.randomUUID() } as const
    const invalid = [
      { ...key, expectedRevision: -1, value: "value" },
      { ...key, expectedRevision: 0.5, value: "value" },
      { ...key, expectedRevision: Number.MAX_SAFE_INTEGER, value: "value" },
      { ...key, key: "é".repeat(UserState.keyLimit), expectedRevision: 0, value: "value" },
      { ...key, key: "nul\u0000key", expectedRevision: 0, value: "value" },
      { ...key, expectedRevision: 0, value: "\uD800" },
      { ...key, expectedRevision: 0, value: "é".repeat(UserState.valueLimit) },
    ]
    for (const input of invalid) {
      expect(
        await first.runPromise(
          write(input).pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "unexpected" })),
        ),
      ).toBe("UserState.InvalidInput")
    }
    expect(await first.runPromise(read(key))).toEqual({ revision: 0, value: null })
  })
})
