import { expect, test } from "bun:test"
import { scryptSync } from "node:crypto"
import { Effect, Exit, Layer } from "effect"
import { Database } from "../src/database/database"
import { UserService } from "../src/user"
import { UserTable } from "../src/user/sql"

const services = UserService.layer.pipe(Layer.provideMerge(Database.layerFromConfig(Database.configFromEnvironment())))

test("the original user service persists and authenticates through PostgreSQL", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const users = yield* UserService
      expect(yield* users.userExists()).toBe(false)
      const input = { username: "account", email: "account@example.test", password: "existing-password" }
      const identity = yield* users.createUser(input)
      expect(yield* users.userExists()).toBe(true)
      expect(yield* users.authenticateUser({ usernameOrEmail: input.username, password: input.password })).toEqual(
        identity,
      )
      expect(yield* users.authenticateUser({ usernameOrEmail: input.email, password: input.password })).toEqual(
        identity,
      )
      expect(yield* users.authenticateUser({ usernameOrEmail: input.username, password: "incorrect" })).toBeNull()
      expect(yield* users.authenticateUser({ usernameOrEmail: "missing", password: input.password })).toBeNull()
      const row = yield* users.getUserById(identity.id)
      expect(row?.password_hash).not.toContain(input.password)
      expect(row?.username).toBe(input.username)
      expect(yield* users.getUserById("missing")).toBeNull()
    }).pipe(Effect.provide(services)),
  ))

test("accounts retain compatibility with the original scrypt password format", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const users = yield* UserService
      const { db } = yield* Database.Service
      const salt = "0123456789abcdef0123456789abcdef"
      yield* db.insert(UserTable).values({
        id: "legacy-account",
        username: "legacy",
        email: "legacy@example.test",
        password_hash: `${salt}:${scryptSync("legacy-password", salt, 64).toString("hex")}`,
      })
      expect(yield* users.authenticateUser({ usernameOrEmail: "legacy", password: "legacy-password" })).toEqual({
        id: "legacy-account",
        username: "legacy",
        email: "legacy@example.test",
      })
    }).pipe(Effect.provide(services)),
  ))

test("user creation participates in the caller's database transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const users = yield* UserService
      const { db } = yield* Database.Service
      const result = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            yield* users.createUser({
              username: "rolled-back",
              email: "rollback@example.test",
              password: "test-password",
            })
            expect(yield* users.userExists()).toBe(true)
            return yield* Effect.fail("rollback")
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* users.userExists()).toBe(false)
    }).pipe(Effect.provide(services)),
  ))
