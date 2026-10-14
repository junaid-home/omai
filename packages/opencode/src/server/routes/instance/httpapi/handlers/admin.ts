import { Authentication } from "@opencode-ai/core/authentication"
import { Database } from "@opencode-ai/core/database/database"
import { UserTable } from "@opencode-ai/core/user/sql"
import type { Role } from "@opencode-ai/core/user/permissions"
import { effectiveSettingsPermissions } from "@opencode-ai/core/user/permissions"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { hashPassword } from "@/user"
import { effectiveRole } from "@/auth/role"
import { ConflictError, ForbiddenError, InvalidRequestError } from "../errors"
import type { AdminUser } from "../groups/admin"
import { AdminCreateUserInput, AdminUpdateUserInput } from "../groups/admin"

export const requireAdmin = Effect.fn("AdminHttpApi.requireAdmin")(function* () {
  const principal = yield* Authentication.Current
  if (!principal || principal.role !== "admin")
    return yield* new ForbiddenError({ message: "Administrator access is required" })
  return principal
})

function toAdminUser(row: typeof UserTable.$inferSelect): AdminUser {
  const role = effectiveRole(row.username, row.role as Role | null)
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role,
    settingsPermissions: effectiveSettingsPermissions(row.settings_permissions, role === "admin"),
    model: row.model ?? null,
  }
}

function validUsername(username: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/.test(username)
}

function validEmail(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function validPassword(password: string) {
  return password.length >= 12 && Buffer.byteLength(password) <= 1024
}

export const adminHandlers = HttpApiBuilder.group(RootHttpApi, "admin", (handlers) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const list = Effect.fn("AdminHttpApi.list")(function* () {
      yield* requireAdmin()
      const rows = yield* db.select().from(UserTable).pipe(Effect.orDie)
      return rows.map(toAdminUser)
    })

    const create = Effect.fn("AdminHttpApi.create")(function* (ctx: { payload: typeof AdminCreateUserInput.Type }) {
      yield* requireAdmin()
      const payload = ctx.payload
      if (!validUsername(payload.username))
        return yield* new InvalidRequestError({
          message: "Username must contain 3-30 letters, numbers, underscores or hyphens",
        })
      const email = payload.email.trim().toLowerCase()
      if (!validEmail(email)) return yield* new InvalidRequestError({ message: "Invalid email address" })
      if (!validPassword(payload.password))
        return yield* new InvalidRequestError({
          message: "Password must contain at least 12 characters and at most 1024 bytes",
        })
      const password = yield* Effect.promise(() => hashPassword(payload.password))
      const now = Date.now()
      const created = yield* db
        .insert(UserTable)
        .values({
          id: randomUUID(),
          username: payload.username,
          email,
          password_hash: password,
          role: payload.role ?? "member",
          settings_permissions: payload.settingsPermissions ?? null,
          model: payload.model ?? null,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .returning()
        .pipe(Effect.orDie)
      if (created.length !== 1) return yield* new ConflictError({ message: "A user with those details already exists" })
      return toAdminUser(created[0])
    })

    const update = Effect.fn("AdminHttpApi.update")(function* (ctx: {
      params: { userID: string }
      payload: typeof AdminUpdateUserInput.Type
    }) {
      const principal = yield* requireAdmin()
      const existing = yield* db
        .select()
        .from(UserTable)
        .where(eq(UserTable.id, ctx.params.userID))
        .limit(1)
        .pipe(Database.first, Effect.orDie)
      if (!existing) return yield* new HttpApiError.NotFound({})
      if (ctx.params.userID === principal.userID && ctx.payload.role === "member")
        return yield* new ForbiddenError({ message: "An admin cannot demote their own account" })
      const set: Partial<typeof UserTable.$inferInsert> = {}
      if (ctx.payload.role !== undefined) set.role = ctx.payload.role
      if (ctx.payload.settingsPermissions !== undefined) set.settings_permissions = ctx.payload.settingsPermissions
      if (ctx.payload.model !== undefined) set.model = ctx.payload.model
      if (ctx.payload.password !== undefined) {
        if (!validPassword(ctx.payload.password))
          return yield* new InvalidRequestError({
            message: "Password must contain at least 12 characters and at most 1024 bytes",
          })
        set.password_hash = yield* Effect.promise(() => hashPassword(ctx.payload.password!))
      }
      if (Object.keys(set).length === 0) return toAdminUser(existing)
      const updated = yield* db
        .update(UserTable)
        .set(set)
        .where(eq(UserTable.id, ctx.params.userID))
        .returning()
        .pipe(Effect.orDie)
      return toAdminUser(updated[0])
    })

    const remove = Effect.fn("AdminHttpApi.remove")(function* (ctx: { params: { userID: string } }) {
      const principal = yield* requireAdmin()
      const existing = yield* db
        .select({ id: UserTable.id })
        .from(UserTable)
        .where(eq(UserTable.id, ctx.params.userID))
        .limit(1)
        .pipe(Database.first, Effect.orDie)
      if (!existing) return yield* new HttpApiError.NotFound({})
      if (ctx.params.userID === principal.userID)
        return yield* new ForbiddenError({ message: "An admin cannot delete their own account" })
      yield* db.delete(UserTable).where(eq(UserTable.id, ctx.params.userID)).pipe(Effect.orDie)
      return true
    })

    return handlers.handle("list", list).handle("create", create).handle("update", update).handle("remove", remove)
  }),
)
