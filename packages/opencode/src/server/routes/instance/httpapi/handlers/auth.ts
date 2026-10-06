import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Effect, Option, Schema, Semaphore, Stream } from "effect"
import { and, eq, isNull, or } from "drizzle-orm"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Authentication } from "@opencode-ai/core/authentication"
import { AuthSessionTable } from "@opencode-ai/core/auth-session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { UserTable } from "@opencode-ai/core/user/sql"
import { requestToken, sameOrigin, sessionCookie } from "@opencode-ai/server/authentication"
import { RootHttpApi } from "../api"
import { AuthLoginInput, AuthSignupInput } from "../groups/auth"
import { generateToken, TOKEN_LIFETIME_MS } from "@/auth/jwt"
import { hashPassword, verifyPassword } from "@/user"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"

function error(message: string, status: number) {
  return HttpServerResponse.jsonUnsafe({ error: message }, { status, headers: { "Cache-Control": "no-store" } })
}

function body(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    let size = 0
    const chunks = yield* request.stream.pipe(
      Stream.mapEffect((chunk) => {
        size += chunk.byteLength
        return size > 16_384 ? Effect.fail(new Error("Request body too large")) : Effect.succeed(chunk)
      }),
      Stream.runCollect,
    )
    return Buffer.concat(chunks).toString("utf8")
  }).pipe(Effect.option)
}

function invitation(value: string | undefined) {
  if (!Authentication.central()) return true
  const current = Authentication.secret("OPENCODE_REGISTRATION_SECRET")
  const legacy = Authentication.secret("OPENCODE_SIGNUP_TOKEN")
  if (current && legacy) throw new Error("Configure one registration secret")
  const expected = current ?? legacy
  if (!expected || expected.length < 32 || !value || value.length > 1024) return false
  return timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(value).digest())
}

export const authHandlers = HttpApiBuilder.group(RootHttpApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const authentication = yield* Authentication.Service
    const dummyHash = yield* Effect.promise(() => hashPassword(randomUUID()))
    const hashSlots = Semaphore.makeUnsafe(4)
    const attempts = new Map<string, { count: number; until: number }>()
    const allowed = (key: string, limit = 10) => {
      const now = Date.now()
      for (const [name, attempt] of attempts) if (attempt.until <= now) attempts.delete(name)
      const value = attempts.get(key)
      if (value && value.count >= limit) return false
      if (!value && attempts.size >= 2048) return false
      attempts.set(key, { count: (value?.count ?? 0) + 1, until: value?.until ?? now + 60_000 })
      return true
    }

    const issue = Effect.fn("Auth.issue")(function* (user: { id: string; username: string; email: string }) {
      const now = Date.now()
      const sessionID = randomUUID()
      const token = yield* Effect.promise(() =>
        generateToken({ sub: user.id, username: user.username, email: user.email, jti: sessionID }),
      )
      yield* db
        .insert(AuthSessionTable)
        .values({
          id: sessionID,
          user_id: user.id,
          time_created: now,
          time_expires: now + TOKEN_LIFETIME_MS,
        })
        .pipe(Effect.orDie)
      return HttpServerResponse.jsonUnsafe(
        { token, user },
        {
          headers: { "Set-Cookie": sessionCookie(token, TOKEN_LIFETIME_MS / 1000), "Cache-Control": "no-store" },
        },
      )
    })

    return handlers
      .handle("config", () =>
        Effect.succeed({
          mode: Authentication.central() ? ("central" as const) : ("local" as const),
          workspaceRoot: CentralStorage.workspaceRoot(),
        }),
      )
      .handleRaw(
        "signup",
        Effect.fn("Auth.signup")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (!sameOrigin(request)) return error("Origin is not allowed", 403)
          const text = yield* body(request)
          if (Option.isNone(text)) return error("Invalid request body", 400)
          const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(AuthSignupInput))(text.value)
          if (Option.isNone(decoded)) return error("Invalid signup request", 400)
          const input = decoded.value
          if (!invitation(input.inviteToken)) return error("A valid invitation is required", 403)
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/.test(input.username))
            return error("Username must contain 3-30 letters, numbers, underscores or hyphens", 400)
          const email = input.email.trim().toLowerCase()
          if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return error("Invalid email address", 400)
          if (input.password.length < 12 || Buffer.byteLength(input.password) > 1024)
            return error("Password must contain at least 12 characters and at most 1024 bytes", 400)
          if (!allowed(`signup:${email}`) || !allowed("signup:global"))
            return error("Too many attempts; try again later", 429)
          const password = yield* Effect.promise(() => hashPassword(input.password)).pipe(hashSlots.withPermit)
          const user = { id: randomUUID(), username: input.username, email }
          const now = Date.now()
          const created = yield* db
            .insert(UserTable)
            .values({ ...user, password_hash: password, time_created: now, time_updated: now })
            .onConflictDoNothing()
            .returning({ id: UserTable.id })
            .pipe(Effect.orDie)
          if (created.length !== 1) return error("Account cannot be created with those details", 409)
          return yield* issue(user)
        }),
      )
      .handleRaw(
        "login",
        Effect.fn("Auth.login")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (!sameOrigin(request)) return error("Origin is not allowed", 403)
          const text = yield* body(request)
          if (Option.isNone(text)) return error("Invalid request body", 400)
          const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(AuthLoginInput))(text.value)
          if (Option.isNone(decoded)) return error("Invalid login request", 400)
          const input = decoded.value
          if (
            !input.usernameOrEmail ||
            input.usernameOrEmail.length > 254 ||
            !input.password ||
            Buffer.byteLength(input.password) > 1024
          )
            return error("Invalid credentials", 401)
          const name = input.usernameOrEmail.trim()
          if (!allowed(`login:${name.toLowerCase()}`) || !allowed("login:global", 120))
            return error("Too many attempts; try again later", 429)
          const users = yield* db
            .select()
            .from(UserTable)
            .where(or(eq(UserTable.username, name), eq(UserTable.email, name.toLowerCase())))
            .limit(1)
            .pipe(Effect.orDie)
          const user = users[0]
          const valid = yield* Effect.promise(() =>
            verifyPassword(input.password, user?.password_hash ?? dummyHash),
          ).pipe(hashSlots.withPermit)
          if (!valid || !user) return error("Invalid credentials", 401)
          return yield* issue({ id: user.id, username: user.username, email: user.email })
        }),
      )
      .handleRaw(
        "me",
        Effect.fn("Auth.me")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const token = requestToken(request.headers)
          if (!token) return error("Not authenticated", 401)
          const principal = yield* authentication.authenticate(token.token)
          if (!principal) return error("Invalid or expired session", 401)
          return HttpServerResponse.jsonUnsafe(
            { id: principal.userID, username: principal.username, email: principal.email },
            { headers: { "Cache-Control": "no-store" } },
          )
        }),
      )
      .handleRaw(
        "logout",
        Effect.fn("Auth.logout")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (!sameOrigin(request)) return error("Origin is not allowed", 403)
          const token = requestToken(request.headers)
          const principal = token ? yield* authentication.authenticate(token.token) : undefined
          if (principal)
            yield* db
              .update(AuthSessionTable)
              .set({ time_revoked: Date.now() })
              .where(and(eq(AuthSessionTable.id, principal.sessionID), isNull(AuthSessionTable.time_revoked)))
              .pipe(Effect.orDie)
          return HttpServerResponse.jsonUnsafe(true, {
            headers: { "Set-Cookie": sessionCookie("", 0), "Cache-Control": "no-store" },
          })
        }),
      )
  }),
)
