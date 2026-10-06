import { NodeHttpServer } from "@effect/platform-node"
import { Authentication } from "@opencode-ai/core/authentication"
import { AuthSessionTable } from "@opencode-ai/core/auth-session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { UserTable } from "@opencode-ai/core/user/sql"
import { AuthenticationHttp } from "@opencode-ai/server/authentication"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { AuthSession } from "../../src/auth/session"
import { generateToken } from "../../src/auth/jwt"
import { ServerAuth } from "../../src/server/auth"
import { Authorization, authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

const environment = new Map<string, string | undefined>()
beforeEach(() => {
  environment.set("OPENCODE_AUTH_MODE", process.env.OPENCODE_AUTH_MODE)
  process.env.OPENCODE_AUTH_MODE = "central"
  environment.set("OPENCODE_PUBLIC_URL", process.env.OPENCODE_PUBLIC_URL)
  process.env.OPENCODE_PUBLIC_URL = "https://app.example.test"
  environment.set("OPENCODE_JWT_SECRET", process.env.OPENCODE_JWT_SECRET)
  process.env.OPENCODE_JWT_SECRET = crypto.randomUUID() + crypto.randomUUID()
})
afterEach(() => {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  environment.clear()
})

const Api = HttpApi.make("central-probe").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("get", "/private", { success: Schema.String }),
      HttpApiEndpoint.post("post", "/private", { success: Schema.String }),
    )
    .middleware(Authorization),
)
const principal = Authentication.Current.pipe(Effect.map((value) => value?.userID ?? "missing"))
const handlers = HttpApiBuilder.group(Api, "probe", (handlers) =>
  handlers.handle("get", () => principal).handle("post", () => principal),
)
const routes = Layer.mergeAll(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add("GET", "/file/image", () => Effect.succeed(HttpServerResponse.text("protected")))
      for (const document of ["/", "/login", "/signup-secret-route", "/assets/fixture.js"] as const)
        yield* router.add("GET", document, () => Effect.succeed(HttpServerResponse.text("public document")))
    }),
  ),
).pipe(Layer.provide(AuthenticationHttp.middleware))
const it = testEffect(
  HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
    Layer.provide(AuthSession.layer),
    Layer.provideMerge(Database.layerFromConfig(Database.configFromEnvironment())),
  ),
)
const account = Effect.gen(function* () {
  const database = yield* Database.Service
  const id = crypto.randomUUID()
  const sessionID = crypto.randomUUID()
  yield* database.db
    .insert(UserTable)
    .values({ id, username: `user-${id}`, email: `${id}@example.test`, password_hash: "not-used" })
  yield* database.db
    .insert(AuthSessionTable)
    .values({ id: sessionID, user_id: id, time_created: Date.now(), time_expires: Date.now() + 60_000 })
  const token = yield* Effect.promise(() =>
    generateToken({ sub: id, jti: sessionID, username: `user-${id}`, email: `${id}@example.test` }),
  )
  return { id, sessionID, token, cookie: `${AuthenticationHttp.SESSION_COOKIE}=${token}` }
})
const get = (path: string, headers: Record<string, string> = {}) =>
  HttpClientRequest.get(path).pipe(HttpClientRequest.setHeaders(headers), HttpClient.execute)

describe("central authenticated HTTP boundary", () => {
  it.live("serves the original login and invitation signup documents before authentication", () =>
    Effect.gen(function* () {
      for (const document of ["/", "/login", "/signup-secret-route", "/assets/fixture.js"]) {
        const response = yield* HttpClient.get(document)
        expect(response.status).toBe(200)
        expect(yield* response.text).toBe("public document")
      }
      for (const privatePath of ["/signup-secret-route-extra", "/auth/me", "/user-state", "/private"])
        expect((yield* HttpClient.get(privatePath)).status).toBe(401)
      expect((yield* HttpClient.post("/signup-secret-route")).status).toBe(401)
    }),
  )
  it.live("protects typed and raw routes and propagates the DB-verified principal", () =>
    Effect.gen(function* () {
      const user = yield* account
      for (const path of ["/private", "/file/image"]) {
        expect((yield* HttpClient.get(path)).status).toBe(401)
        expect((yield* HttpClient.get(`${path}?auth_token=Zm9vOmJhcg==`)).status).toBe(401)
      }
      const response = yield* get("/private", { cookie: user.cookie })
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(user.id)
      expect((yield* get("/private", { authorization: `Bearer ${user.token}` })).status).toBe(200)
    }),
  )
  it.live("rejects preview-origin and missing-origin cookie mutations", () =>
    Effect.gen(function* () {
      const user = yield* account
      for (const origin of [undefined, "https://preview.example.test", "null"]) {
        const response = yield* HttpClientRequest.post("/private").pipe(
          HttpClientRequest.setHeaders({ cookie: user.cookie, ...(origin ? { origin } : {}) }),
          HttpClient.execute,
        )
        expect(response.status).toBe(403)
      }
      const response = yield* HttpClientRequest.post("/private").pipe(
        HttpClientRequest.setHeaders({ cookie: user.cookie, origin: process.env.OPENCODE_PUBLIC_URL! }),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
    }),
  )
  it.live("rejects revoked and expired sessions even with valid JWT signatures", () =>
    Effect.gen(function* () {
      const user = yield* account
      const database = yield* Database.Service
      yield* database.db
        .update(AuthSessionTable)
        .set({ time_revoked: Date.now() })
        .where(eq(AuthSessionTable.id, user.sessionID))
      expect((yield* get("/private", { authorization: `Bearer ${user.token}` })).status).toBe(401)
      yield* database.db
        .update(AuthSessionTable)
        .set({ time_revoked: null, time_expires: Date.now() - 1 })
        .where(eq(AuthSessionTable.id, user.sessionID))
      expect((yield* get("/private", { cookie: user.cookie })).status).toBe(401)
    }),
  )
  it.live("rejects malformed or ambiguous session credentials", () =>
    Effect.gen(function* () {
      const user = yield* account
      for (const cookie of [`${user.cookie}; ${user.cookie}`, "omai_session=not.a.token"])
        expect((yield* get("/private", { cookie })).status).toBe(401)
      expect((yield* get("/private", { cookie: user.cookie, authorization: "Bearer invalid token" })).status).toBe(401)
    }),
  )
  it.live("emits a host-only secure HttpOnly cookie", () =>
    Effect.gen(function* () {
      const user = yield* account
      const cookie = AuthenticationHttp.sessionCookie(user.token, 60)
      expect(cookie).toContain("HttpOnly")
      expect(cookie).toContain("Secure")
      expect(cookie).toContain("SameSite=Lax")
      expect(cookie).not.toContain("Domain=")
    }),
  )
})
