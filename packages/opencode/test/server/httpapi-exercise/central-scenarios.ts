import { Effect } from "effect"
import { check, object } from "./assertions"
import { http } from "./dsl"

export const centralScenarios = [
  http.public
    .get("/auth/config", "central.auth.config")
    .central()
    .global()
    .at((ctx) => ({ path: "/auth/config", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.mode === "central", "bootstrap must identify hosted authentication")
      check(
        Object.keys(body).every((key) => key === "mode" || key === "workspaceRoot"),
        "bootstrap must not expose secrets",
      )
    }),
  http.public
    .post("/auth/signup", "central.auth.signup")
    .central()
    .global()
    .at((ctx) => ({
      path: "/auth/signup",
      headers: ctx.headers(),
      body: {
        username: "httpapi_signup",
        email: "httpapi-signup@example.test",
        password: "HTTP signup test password",
        inviteToken: process.env.OPENCODE_REGISTRATION_SECRET,
      },
    }))
    .status(200, (ctx, result) =>
      Effect.gen(function* () {
        object(result.body)
        object(result.body.user)
        check(result.body.user.username === "httpapi_signup", "signup must return the created account")
        check(!("password_hash" in result.body.user), "signup must never return password hashes")
        const cookie = result.headers.get("set-cookie")
        check(
          !!cookie && cookie.includes("HttpOnly") && cookie.includes("Secure") && cookie.includes("SameSite=Lax"),
          "signup must issue a secure session cookie",
        )
        const me = yield* ctx.request("GET", { path: "/auth/me", headers: { cookie: cookie.split(";")[0] } })
        object(me.body)
        check(
          me.status === 200 && me.body.id === result.body.user.id,
          "issued session must authenticate the persisted account",
        )
      }),
    ),
  http.public
    .post("/auth/login", "central.auth.login")
    .central()
    .global()
    .at((ctx) => ({
      path: "/auth/login",
      headers: ctx.headers(),
      body: {
        usernameOrEmail: ctx.account!.email,
        password: ctx.account!.password,
      },
    }))
    .status(200, (ctx, result) =>
      Effect.gen(function* () {
        object(result.body)
        object(result.body.user)
        check(result.body.user.id === ctx.account!.id, "login must resolve the existing PostgreSQL user")
        const cookie = result.headers.get("set-cookie")?.split(";")[0]
        check(!!cookie && cookie !== ctx.account!.cookie, "login must issue a new session")
        const me = yield* ctx.request("GET", { path: "/auth/me", headers: { cookie } })
        object(me.body)
        check(me.status === 200 && me.body.id === ctx.account!.id, "new login cookie must authenticate")
      }),
    ),
  http.protected
    .get("/auth/me", "central.auth.me")
    .central()
    .global()
    .at((ctx) => ({ path: "/auth/me", headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      check(
        body.id === ctx.account!.id && body.email === ctx.account!.email,
        "me must return the session's exact persisted identity",
      )
      check(Object.keys(body).sort().join(",") === "email,id,username", "me must not leak credential fields")
    }),
  http.protected
    .post("/auth/logout", "central.auth.logout")
    .central()
    .global()
    .at((ctx) => ({ path: "/auth/logout", headers: ctx.headers() }))
    .status(200, (ctx, result) =>
      Effect.gen(function* () {
        check(result.body === true, "logout should acknowledge revocation")
        check(result.headers.get("set-cookie")?.includes("Max-Age=0") === true, "logout must clear browser cookie")
        const me = yield* ctx.request("GET", { path: "/auth/me" })
        check(me.status === 401, "revoked cookie must fail against the real auth session store")
      }),
    ),
  http.protected
    .get("/user-state", "central.userState.get")
    .central()
    .global()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const saved = yield* ctx.request("PUT", {
          path: "/user-state",
          body: {
            namespace: "drafts",
            key: "exercise-read",
            expectedRevision: 0,
            value: "stored draft",
          },
        })
        check(saved.status === 200, "read fixture must persist state through HTTP")
      }),
    )
    .at((ctx) => ({ path: "/user-state?namespace=drafts&key=exercise-read", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.revision === 1 && body.value === "stored draft", "read must return persisted value and revision")
    }),
  http.protected
    .put("/user-state", "central.userState.put")
    .central()
    .global()
    .at((ctx) => ({
      path: "/user-state",
      headers: ctx.headers(),
      body: {
        namespace: "drafts",
        key: "exercise-write",
        expectedRevision: 0,
        value: "first write",
      },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.revision === 1 && body.value === "first write", "write must commit revision one")
        const conflict = yield* ctx.request("PUT", {
          path: "/user-state",
          body: {
            namespace: "drafts",
            key: "exercise-write",
            expectedRevision: 0,
            value: "stale write",
          },
        })
        check(conflict.status === 409, "stale writer must receive a conflict")
        const reread = yield* ctx.request("GET", { path: "/user-state?namespace=drafts&key=exercise-write" })
        object(reread.body)
        check(
          reread.body.revision === 1 && reread.body.value === "first write",
          "conflict must preserve committed state",
        )
        const wrongUser = yield* ctx.request("GET", {
          path: "/user-state?namespace=drafts&key=exercise-write",
          headers: { "x-opencode-user-id": "another-user" },
        })
        check(wrongUser.status === 401, "account-switch precondition must reject a mismatched user")
      }),
    ),
  http.protected
    .post("/global/preview/static", "central.preview.static")
    .central()
    .at((ctx) => ({
      path: "/global/preview/static",
      headers: ctx.headers(),
      body: {
        directory: ctx.directory,
        html: "<!doctype html><html><body>Static fixture</body></html>",
      },
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.url === "string", "static preview should issue a URL")
      const url = new URL(body.url)
      check(
        url.origin === "https://preview.example.test" &&
          url.pathname.startsWith("/static/") &&
          !!url.searchParams.get("ticket"),
        "static preview must use the isolated origin and one-time capability",
      )
    }),
]
