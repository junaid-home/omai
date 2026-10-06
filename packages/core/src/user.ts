import { randomUUID } from "node:crypto"
import { eq, or } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { hashPassword, verifyPassword } from "./user/password"
import { UserTable } from "./user/sql"

type Identity = Pick<typeof UserTable.$inferSelect, "id" | "username" | "email">

export interface Interface {
  readonly createUser: (input: { username: string; email: string; password: string }) => Effect.Effect<Identity>
  readonly authenticateUser: (input: { usernameOrEmail: string; password: string }) => Effect.Effect<Identity | null>
  readonly getUserById: (id: string) => Effect.Effect<typeof UserTable.$inferSelect | null>
  readonly userExists: () => Effect.Effect<boolean>
}

export class UserService extends Context.Service<UserService, Interface>()("@opencode/UserService") {
  static readonly layer: Layer.Layer<UserService, never, Database.Service> = Layer.suspend(() => layer)
}

export const layer = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const createUser = Effect.fn("UserService.createUser")(function* (input: {
      username: string
      email: string
      password: string
    }) {
      const password = yield* Effect.promise(() => hashPassword(input.password))
      const user = { id: randomUUID(), username: input.username, email: input.email }
      yield* db
        .insert(UserTable)
        .values({ ...user, password_hash: password })
        .pipe(Effect.orDie)
      return user
    })

    const authenticateUser = Effect.fn("UserService.authenticateUser")(function* (input: {
      usernameOrEmail: string
      password: string
    }) {
      const user = yield* db
        .select()
        .from(UserTable)
        .where(or(eq(UserTable.username, input.usernameOrEmail), eq(UserTable.email, input.usernameOrEmail)))
        .limit(1)
        .pipe(Database.first, Effect.orDie)
      if (!user || !(yield* Effect.promise(() => verifyPassword(input.password, user.password_hash)))) return null
      return { id: user.id, username: user.username, email: user.email }
    })

    const getUserById = Effect.fn("UserService.getUserById")(function* (id: string) {
      return (yield* db.select().from(UserTable).where(eq(UserTable.id, id)).pipe(Database.first, Effect.orDie)) ?? null
    })

    const userExists = Effect.fn("UserService.userExists")(function* () {
      return (yield* db.select({ id: UserTable.id }).from(UserTable).limit(1).pipe(Effect.orDie)).length > 0
    })

    return UserService.of({ createUser, authenticateUser, getUserById, userExists })
  }),
)

export * as User from "./user"
