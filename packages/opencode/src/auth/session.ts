import { Authentication } from "@opencode-ai/core/authentication"
import { AuthSessionTable } from "@opencode-ai/core/auth-session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { UserTable } from "@opencode-ai/core/user/sql"
import { and, eq, gt, isNull } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { signingKey, verifyToken } from "./jwt"

export const layer = Layer.effect(
  Authentication.Service,
  Effect.gen(function* () {
    signingKey()
    Authentication.instanceID()
    Authentication.publicOrigin()
    const { db } = yield* Database.Service
    return Authentication.Service.of({
      authenticate: Effect.fn("Authentication.authenticate")(function* (token) {
        const payload = yield* Effect.promise(() => verifyToken(token))
        if (!payload) return undefined
        const row = yield* db
          .select({
            userID: UserTable.id,
            username: UserTable.username,
            email: UserTable.email,
            sessionID: AuthSessionTable.id,
          })
          .from(AuthSessionTable)
          .innerJoin(UserTable, eq(AuthSessionTable.user_id, UserTable.id))
          .where(
            and(
              eq(AuthSessionTable.id, payload.jti),
              eq(AuthSessionTable.user_id, payload.sub),
              gt(AuthSessionTable.time_expires, Date.now()),
              isNull(AuthSessionTable.time_revoked),
            ),
          )
          .pipe(Database.first, Effect.orDie)
        if (!row) return undefined
        return { ...row, instanceID: Authentication.instanceID() }
      }),
    })
  }),
)

export * as AuthSession from "./session"
