import { Effect } from "effect"
import { array, check, isRecord, object } from "./assertions"
import { http, route } from "./dsl"
import type { ScenarioContext } from "./types"

const fullPermissions = {
  general: true,
  terminal: true,
  fileTree: true,
  shortcuts: true,
  servers: true,
  providers: true,
  models: true,
  mcp: true,
} as const

function signup(ctx: ScenarioContext, body: { username: string; email: string; password: string }) {
  return Effect.gen(function* () {
    const response = yield* ctx.request("POST", {
      path: "/auth/signup",
      body: { ...body, inviteToken: process.env.OPENCODE_REGISTRATION_SECRET },
    })
    check(response.status === 200, `fixture signup for ${body.username} failed with ${response.status}`)
    object(response.body)
    object(response.body.user)
    check(typeof response.body.user.id === "string", "signup should issue a user identity")
    const cookie = response.headers.get("set-cookie")?.split(";")[0]
    check(!!cookie, "signup should issue a session cookie")
    return { id: response.body.user.id, cookie }
  })
}

export const centralScenarios = [
  http.public
    .get("/auth/config", "central.auth.config")
    .central()
    .global()
    .at((ctx) => ({ path: "/auth/config", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.mode === "central", "bootstrap must identify hosted authentication")
      check(typeof body.google === "boolean", "bootstrap must report Google sign-in availability")
      check(
        Object.keys(body).every((key) => key === "mode" || key === "workspaceRoot" || key === "google"),
        "bootstrap must not expose secrets",
      )
    }),
  http.public
    .get("/auth/google", "central.auth.google")
    .central()
    .global()
    .at((ctx) => ({ path: "/auth/google", headers: ctx.headers() }))
    .status(302, (_ctx, result) =>
      Effect.sync(() => {
        check(
          result.headers.get("location") === "/login?error=google_unavailable",
          "start without configured credentials must redirect to the login error",
        )
      }),
    ),
  http.public
    .get("/auth/google/callback", "central.auth.googleCallback")
    .central()
    .global()
    .at((ctx) => ({ path: "/auth/google/callback?state=missing&code=placeholder", headers: ctx.headers() }))
    .status(302, (_ctx, result) =>
      Effect.sync(() => {
        check(
          result.headers.get("location") === "/login?error=google_state",
          "callback without the matching state cookie must be rejected",
        )
      }),
    ),
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
      check(
        Object.keys(body).sort().join(",") === "email,id,role,settingsPermissions,username",
        "me must expose identity, role, and permissions without leaking credential fields",
      )
      check(body.role === "admin" || body.role === "member", "me must report a known role")
      object(body.settingsPermissions)
      check(
        Object.keys(body.settingsPermissions).sort().join(",") ===
          "fileTree,general,mcp,models,providers,servers,shortcuts,terminal",
        "me must report every settings scope",
      )
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
  http.protected
    .get("/admin/users", "central.admin.list")
    .central()
    .global()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const admin = yield* signup(ctx, {
          username: "httpapi_admin_list",
          email: "httpapi-admin-list@example.test",
          password: "HTTP admin list password",
        })
        const member = yield* signup(ctx, {
          username: "httpapi_member_list",
          email: "httpapi-member-list@example.test",
          password: "HTTP member list password",
        })
        return { admin, member }
      }),
    )
    .at((ctx) => ({ path: "/admin/users", headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        array(body)
        check(body.length >= 2, "list must include the provisioned admin and member")
        const admin = body.find((user) => isRecord(user) && user.id === ctx.state.admin.id)
        object(admin)
        check(admin.role === "admin", "environment-listed username must resolve to admin")
        const member = body.find((user) => isRecord(user) && user.id === ctx.state.member.id)
        object(member)
        check(member.role === "member", "unlisted username must remain a member")
        for (const user of body) {
          object(user)
          check(
            Object.keys(user).sort().join(",") === "email,id,role,settingsPermissions,username",
            "admin users must not expose password hashes",
          )
          object(user.settingsPermissions)
          check(
            Object.keys(user.settingsPermissions).sort().join(",") ===
              "fileTree,general,mcp,models,providers,servers,shortcuts,terminal",
            "admin users must include every settings scope",
          )
        }
        const denied = yield* ctx.request("GET", { path: "/admin/users", headers: { cookie: ctx.state.member.cookie } })
        check(denied.status === 403, `member must not list users, got ${denied.status}`)
      }),
    ),
  http.protected
    .post("/admin/users", "central.admin.create")
    .central()
    .global()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const admin = yield* signup(ctx, {
          username: "httpapi_admin_create",
          email: "httpapi-admin-create@example.test",
          password: "HTTP admin create password",
        })
        const member = yield* signup(ctx, {
          username: "httpapi_member_create",
          email: "httpapi-member-create@example.test",
          password: "HTTP member create password",
        })
        return { admin, member }
      }),
    )
    .at((ctx) => ({
      path: "/admin/users",
      headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
      body: {
        username: "httpapi_created",
        email: "httpapi-created@example.test",
        password: "HTTP created user password",
        role: "member",
        settingsPermissions: { ...fullPermissions, mcp: false },
      },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.username === "httpapi_created" && body.role === "member", "create must return the new user")
        object(body.settingsPermissions)
        check(
          body.settingsPermissions.mcp === false && body.settingsPermissions.general === true,
          "create must persist the supplied permission overrides",
        )
        const duplicate = yield* ctx.request("POST", {
          path: "/admin/users",
          headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
          body: {
            username: "httpapi_created",
            email: "httpapi-created@example.test",
            password: "HTTP created user password",
          },
        })
        check(duplicate.status === 409, `duplicate username must conflict, got ${duplicate.status}`)
        const invalid = yield* ctx.request("POST", {
          path: "/admin/users",
          headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
          body: { username: "httpapi_invalid", email: "httpapi-invalid@example.test", password: "short" },
        })
        check(invalid.status === 400, `invalid password must be rejected, got ${invalid.status}`)
        const denied = yield* ctx.request("POST", {
          path: "/admin/users",
          headers: { ...ctx.headers(), cookie: ctx.state.member.cookie },
          body: {
            username: "httpapi_denied",
            email: "httpapi-denied@example.test",
            password: "HTTP denied user password",
          },
        })
        check(denied.status === 403, `member must not create users, got ${denied.status}`)
      }),
    ),
  http.protected
    .patch("/admin/users/{userID}", "central.admin.update")
    .central()
    .global()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const admin = yield* signup(ctx, {
          username: "httpapi_admin_update",
          email: "httpapi-admin-update@example.test",
          password: "HTTP admin update password",
        })
        const member = yield* signup(ctx, {
          username: "httpapi_member_update",
          email: "httpapi-member-update@example.test",
          password: "HTTP member update password",
        })
        return { admin, member }
      }),
    )
    .at((ctx) => ({
      path: route("/admin/users/{userID}", { userID: ctx.state.member.id }),
      headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
      body: { settingsPermissions: { ...fullPermissions, mcp: false } },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.id === ctx.state.member.id, "update must target the requested user")
        object(body.settingsPermissions)
        check(body.settingsPermissions.mcp === false, "update must persist permission overrides")
        const me = yield* ctx.request("GET", { path: "/auth/me", headers: { cookie: ctx.state.member.cookie } })
        object(me.body)
        object(me.body.settingsPermissions)
        check(
          me.body.role === "member" && me.body.settingsPermissions.mcp === false,
          "member session must reflect the updated permissions",
        )
        const selfDemote = yield* ctx.request("PATCH", {
          path: route("/admin/users/{userID}", { userID: ctx.state.admin.id }),
          headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
          body: { role: "member" },
        })
        check(selfDemote.status === 403, `self-demotion must be forbidden, got ${selfDemote.status}`)
        const missing = yield* ctx.request("PATCH", {
          path: route("/admin/users/{userID}", { userID: "httpapi_missing_user" }),
          headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
          body: { role: "admin" },
        })
        check(missing.status === 404, `unknown user must be a 404, got ${missing.status}`)
      }),
    ),
  http.protected
    .delete("/admin/users/{userID}", "central.admin.remove")
    .central()
    .global()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const admin = yield* signup(ctx, {
          username: "httpapi_admin_remove",
          email: "httpapi-admin-remove@example.test",
          password: "HTTP admin remove password",
        })
        const member = yield* signup(ctx, {
          username: "httpapi_member_remove",
          email: "httpapi-member-remove@example.test",
          password: "HTTP member remove password",
        })
        return { admin, member }
      }),
    )
    .at((ctx) => ({
      path: route("/admin/users/{userID}", { userID: ctx.state.member.id }),
      headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "remove must return true")
        const revoked = yield* ctx.request("GET", { path: "/auth/me", headers: { cookie: ctx.state.member.cookie } })
        check(revoked.status === 401, `removed session must be revoked, got ${revoked.status}`)
        const selfDelete = yield* ctx.request("DELETE", {
          path: route("/admin/users/{userID}", { userID: ctx.state.admin.id }),
          headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
        })
        check(selfDelete.status === 403, `self-deletion must be forbidden, got ${selfDelete.status}`)
        const missing = yield* ctx.request("DELETE", {
          path: route("/admin/users/{userID}", { userID: "httpapi_missing_user" }),
          headers: { ...ctx.headers(), cookie: ctx.state.admin.cookie },
        })
        check(missing.status === 404, `unknown user must be a 404, got ${missing.status}`)
      }),
    ),
  http.protected
    .put("/auth/{providerID}", "central.settingsPermission.deny")
    .central()
    .global()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const admin = yield* signup(ctx, {
          username: "httpapi_admin_scope",
          email: "httpapi-admin-scope@example.test",
          password: "HTTP admin scope password",
        })
        const created = yield* ctx.request("POST", {
          path: "/admin/users",
          headers: { cookie: admin.cookie },
          body: {
            username: "httpapi_limited",
            email: "httpapi-limited@example.test",
            password: "HTTP limited user password",
            role: "member",
            settingsPermissions: { ...fullPermissions, providers: false },
          },
        })
        check(created.status === 200, `restricted user creation failed with ${created.status}`)
        const login = yield* ctx.request("POST", {
          path: "/auth/login",
          body: { usernameOrEmail: "httpapi_limited", password: "HTTP limited user password" },
        })
        check(login.status === 200, `restricted user login failed with ${login.status}`)
        const limitedCookie = login.headers.get("set-cookie")?.split(";")[0]
        check(!!limitedCookie, "restricted login must issue a session cookie")
        return { admin, limitedCookie }
      }),
    )
    .at((ctx) => ({
      path: route("/auth/{providerID}", { providerID: "httpapi" }),
      headers: { ...ctx.headers(), cookie: ctx.state.limitedCookie },
      body: { type: "api", key: "httpapi-test-key" },
    }))
    .status(403),
]
