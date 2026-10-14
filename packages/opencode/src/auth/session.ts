import { Authentication } from "@opencode-ai/core/authentication"
import { AuthSessionTable } from "@opencode-ai/core/auth-session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { UserTable } from "@opencode-ai/core/user/sql"
import type { Role } from "@opencode-ai/core/user/permissions"
import { effectiveSettingsPermissions } from "@opencode-ai/core/user/permissions"
import { and, eq, gt, isNull } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { signingKey, verifyToken } from "./jwt"
import { effectiveRole } from "./role"

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
            role: UserTable.role,
            settingsPermissions: UserTable.settings_permissions,
            model: UserTable.model,
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
        const role = effectiveRole(row.username, row.role as Role | null)
        return {
          userID: row.userID,
          username: row.username,
          email: row.email,
          sessionID: row.sessionID,
          instanceID: Authentication.instanceID(),
          role,
          settingsPermissions: effectiveSettingsPermissions(row.settingsPermissions, role === "admin"),
          model: row.model ?? null,
        }
      }),
    })
  }),
)

export * as AuthSession from "./session"
