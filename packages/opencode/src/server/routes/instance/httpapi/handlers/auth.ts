import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Effect, Option, Schema, Semaphore, Stream } from "effect"
import { and, eq, isNull, or } from "drizzle-orm"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Authentication } from "@opencode-ai/core/authentication"
import { AuthSessionTable } from "@opencode-ai/core/auth-session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { UserTable } from "@opencode-ai/core/user/sql"
import { effectiveSettingsPermissions, type Role } from "@opencode-ai/core/user/permissions"
import { requestToken, sameOrigin, sessionCookie } from "@opencode-ai/server/authentication"
import { RootHttpApi } from "../api"
import { AuthLoginInput, AuthSignupInput } from "../groups/auth"
import { generateToken, TOKEN_LIFETIME_MS } from "@/auth/jwt"
import { effectiveRole } from "@/auth/role"
import { hashPassword, verifyPassword } from "@/user"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"

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

export const GOOGLE_STATE_COOKIE = "omai_google_state"
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"))

/** Google sign-in is offered whenever credentials and a public origin are configured. */
export function googleCredentials() {
  const clientID = Authentication.secret("OPENCODE_GOOGLE_CLIENT_ID")
  const clientSecret = Authentication.secret("OPENCODE_GOOGLE_CLIENT_SECRET")
  const origin = Authentication.publicOrigin()
  if (!clientID || !clientSecret || !origin) return undefined
  return { clientID, clientSecret, origin }
}

/** Derives a signup-conforming username from an email local part, unique-candidate safe. */
export function googleUsernameBase(email: string) {
  let base = (email.split("@")[0] ?? "").replace(/[^a-zA-Z0-9_-]/g, "")
  if (!/^[a-zA-Z0-9]/.test(base)) base = `u${base}`
  if (base.length < 3) base += randomBytes(4).toString("hex")
  return base.slice(0, 24)
}

function stateCookie(nonce: string) {
  return `${GOOGLE_STATE_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${Authentication.central() ? "; Secure" : ""}`
}

function stateMatches(state: string, nonce: string) {
  if (!nonce || state.length !== nonce.length) return false
  return timingSafeEqual(Buffer.from(state), Buffer.from(nonce))
}

function loginRedirect(code: string) {
  return HttpServerResponse.redirect(`/login?error=${code}`)
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

    const issueSession = Effect.fn("Auth.issueSession")(function* (user: {
      id: string
      username: string
      email: string
    }) {
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
      const rows = yield* db
        .select({ role: UserTable.role, settings_permissions: UserTable.settings_permissions })
        .from(UserTable)
        .where(eq(UserTable.id, user.id))
        .limit(1)
        .pipe(Effect.orDie)
      const role = effectiveRole(user.username, (rows[0]?.role ?? null) as Role | null)
      const publicUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        role,
        settingsPermissions: effectiveSettingsPermissions(rows[0]?.settings_permissions ?? null, role === "admin"),
      }
      return { token, user: publicUser, cookie: sessionCookie(token, TOKEN_LIFETIME_MS / 1000) }
    })

    const issue = Effect.fn("Auth.issue")(function* (user: { id: string; username: string; email: string }) {
      const session = yield* issueSession(user)
      return HttpServerResponse.jsonUnsafe(
        { token: session.token, user: session.user },
        { headers: { "Set-Cookie": session.cookie, "Cache-Control": "no-store" } },
      )
    })

    const googleUser = Effect.fn("Auth.googleUser")(function* (email: string) {
      const byEmail = () => db.select().from(UserTable).where(eq(UserTable.email, email)).limit(1).pipe(Effect.orDie)
      const existing = yield* byEmail()
      if (existing[0]) return existing[0]
      const base = googleUsernameBase(email)
      const password = yield* hashSlots.withPermit(Effect.promise(() => hashPassword(randomBytes(32).toString("hex"))))
      const now = Date.now()
      const hasUsers = (yield* db.select({ id: UserTable.id }).from(UserTable).limit(1).pipe(Effect.orDie)).length > 0
      // onConflictDoNothing swallows both email and username conflicts, so retry by
      // picking the next username candidate and re-checking the email on every pass.
      for (let attempt = 0; attempt < 50; attempt++) {
        const username = attempt === 0 ? base : `${base}-${attempt}`
        const created = yield* db
          .insert(UserTable)
          .values({
            id: randomUUID(),
            username,
            email,
            password_hash: password,
            role: hasUsers ? "member" : "admin",
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .returning({ id: UserTable.id })
          .pipe(Effect.orDie)
        if (created.length === 1) return { id: created[0].id, username, email }
        const raced = yield* byEmail()
        if (raced[0]) return raced[0]
      }
      return undefined
    })

    return handlers
      .handle("config", () =>
        Effect.succeed({
          mode: Authentication.central() ? ("central" as const) : ("local" as const),
          workspaceRoot: CentralStorage.workspaceRoot(),
          google: googleCredentials() !== undefined,
        }),
      )
      .handleRaw(
        "google",
        Effect.fn("Auth.google")(function* () {
          const credentials = googleCredentials()
          if (!credentials || !allowed("google:start", 60)) return loginRedirect("google_unavailable")
          const nonce = randomBytes(32).toString("hex")
          const url = new URL(GOOGLE_AUTHORIZE_URL)
          url.searchParams.set("client_id", credentials.clientID)
          url.searchParams.set("redirect_uri", `${credentials.origin}/auth/google/callback`)
          url.searchParams.set("response_type", "code")
          url.searchParams.set("scope", "openid email")
          url.searchParams.set("state", nonce)
          url.searchParams.set("prompt", "select_account")
          return HttpServerResponse.redirect(url, { headers: { "Set-Cookie": stateCookie(nonce) } })
        }),
      )
      .handleRaw(
        "googleCallback",
        Effect.fn("Auth.googleCallback")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://localhost")
          const state = url.searchParams.get("state")
          const nonce = request.cookies[GOOGLE_STATE_COOKIE]
          if (!state || !nonce || !stateMatches(state, nonce)) return loginRedirect("google_state")
          const credentials = googleCredentials()
          if (!credentials || !allowed("google:callback", 60)) return loginRedirect("google_unavailable")
          const providerError = url.searchParams.get("error")
          if (providerError)
            return loginRedirect(providerError === "access_denied" ? "google_denied" : "google_exchange")
          const code = url.searchParams.get("code")
          if (!code || code.length > 4096) return loginRedirect("google_exchange")
          const token = yield* Effect.tryPromise(() =>
            fetch(GOOGLE_TOKEN_URL, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                code,
                client_id: credentials.clientID,
                client_secret: credentials.clientSecret,
                redirect_uri: `${credentials.origin}/auth/google/callback`,
                grant_type: "authorization_code",
              }),
              signal: AbortSignal.timeout(15_000),
            }),
          ).pipe(Effect.option)
          if (Option.isNone(token) || !token.value.ok) return loginRedirect("google_exchange")
          const body = yield* Effect.tryPromise(() => token.value.json()).pipe(Effect.option)
          if (Option.isNone(body)) return loginRedirect("google_exchange")
          const decoded = Schema.decodeUnknownOption(Schema.Struct({ id_token: Schema.optional(Schema.String) }))(
            body.value,
          )
          if (Option.isNone(decoded)) return loginRedirect("google_exchange")
          const idToken = decoded.value.id_token
          if (!idToken) return loginRedirect("google_exchange")
          const verified = yield* Effect.tryPromise(() =>
            jwtVerify(idToken, googleJwks, {
              issuer: ["https://accounts.google.com", "accounts.google.com"],
              audience: credentials.clientID,
            }),
          ).pipe(Effect.option)
          if (Option.isNone(verified)) return loginRedirect("google_exchange")
          const claims = verified.value.payload
          if (
            claims.email_verified !== true ||
            typeof claims.email !== "string" ||
            claims.email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
          )
            return loginRedirect("google_email")
          const user = yield* googleUser(claims.email.trim().toLowerCase())
          if (!user) return loginRedirect("google_unavailable")
          const session = yield* issueSession(user)
          return HttpServerResponse.redirect("/", { headers: { "Set-Cookie": session.cookie } })
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
          const hasUsers = (yield* db.select({ id: UserTable.id }).from(UserTable).limit(1).pipe(Effect.orDie)).length > 0
          const created = yield* db
            .insert(UserTable)
            .values({
              ...user,
              password_hash: password,
              role: hasUsers ? "member" : "admin",
              time_created: now,
              time_updated: now,
            })
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
            {
              id: principal.userID,
              username: principal.username,
              email: principal.email,
              role: principal.role,
              settingsPermissions: principal.settingsPermissions,
            },
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
