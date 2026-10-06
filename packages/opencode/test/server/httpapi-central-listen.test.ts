import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createServer } from "node:net"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Expected TCP address"))
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })

it.live(
  "boots the complete authenticated server and isolated preview listener against PostgreSQL",
  () =>
    Effect.gen(function* () {
      const keys = [
        "OPENCODE_AUTH_MODE",
        "OPENCODE_STORAGE_MODE",
        "OPENCODE_PUBLIC_URL",
        "OPENCODE_PREVIEW_URL",
        "OPENCODE_PREVIEW_PORT",
        "OPENCODE_JWT_SECRET",
        "OPENCODE_REGISTRATION_SECRET",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      ]
      yield* Effect.acquireRelease(
        Effect.sync(() => new Map(keys.map((key) => [key, process.env[key]]))),
        (previous) =>
          Effect.sync(() => {
            for (const [key, value] of previous) {
              if (value === undefined) delete process.env[key]
              else process.env[key] = value
            }
          }),
      )
      process.env.OPENCODE_AUTH_MODE = "central"
      process.env.OPENCODE_STORAGE_MODE = "local"
      process.env.OPENCODE_PUBLIC_URL = "https://app.example.test"
      process.env.OPENCODE_PREVIEW_URL = "https://preview.example.test"
      process.env.OPENCODE_PREVIEW_PORT = String(yield* Effect.promise(freePort))
      process.env.OPENCODE_JWT_SECRET = crypto.randomUUID() + crypto.randomUUID()
      process.env.OPENCODE_REGISTRATION_SECRET = crypto.randomUUID() + crypto.randomUUID()
      process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"
      const project = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "omai-listen-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      )
      yield* Effect.promise(() => writeFile(path.join(project, "opencode.json"), JSON.stringify({ plugin: [] })))
      const { Server } = yield* Effect.promise(() => import("../../src/server/server"))
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const call = (route: string, options: RequestInit = {}) =>
        Effect.promise(() => fetch(new URL(route, listener.url), { ...options, redirect: "manual" }))
      const json = (route: string, value: unknown, cookie?: string) =>
        call(route, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: process.env.OPENCODE_PUBLIC_URL!,
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(value),
        })
      const configuration = yield* call("/auth/config")
      expect(configuration.status).toBe(200)
      // This test uses local storage; Effect encodes the absent workspace root as null.
      expect(yield* Effect.promise(() => configuration.json())).toEqual({ mode: "central", workspaceRoot: null })
      const health = yield* call("/global/health")
      expect(health.status).toBe(200)
      expect(yield* Effect.promise(() => health.json())).toEqual({ healthy: true, version: expect.any(String) })
      expect(health.headers.get("cache-control")).toBe("no-store")
      const liveness = yield* call("/global/live")
      expect(liveness.status).toBe(200)
      expect(yield* Effect.promise(() => liveness.json())).toEqual({ healthy: true, version: expect.any(String) })
      expect((yield* call("/auth/me")).status).toBe(401)
      expect((yield* call("/project")).status).toBe(401)
      const credentials = {
        username: "central_test",
        email: "central@example.test",
        password: "Strong integration password 123",
      }
      expect((yield* json("/auth/signup", credentials)).status).toBe(403)
      const signup = yield* json("/auth/signup", {
        ...credentials,
        inviteToken: process.env.OPENCODE_REGISTRATION_SECRET,
      })
      expect(signup.status).toBe(200)
      const signupBody = yield* Effect.promise(() => signup.json())
      const cookie = signup.headers.get("set-cookie")!.split(";")[0]
      expect(signup.headers.get("set-cookie")).toContain("Secure")
      expect((yield* call("/auth/me", { headers: { cookie } })).status).toBe(200)
      const login = yield* json("/auth/login", {
        usernameOrEmail: credentials.username,
        password: credentials.password,
      })
      expect(login.status).toBe(200)
      expect((yield* call("/project", { headers: { cookie } })).status).toBe(200)
      expect((yield* call(`/session?directory=${encodeURIComponent(project)}`, { headers: { cookie } })).status).toBe(
        200,
      )
      const headers = {
        cookie,
        origin: process.env.OPENCODE_PUBLIC_URL!,
        "x-opencode-user-id": signupBody.user.id,
        "content-type": "application/json",
      }
      const state = yield* call("/user-state", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          namespace: "drafts",
          key: "integration",
          value: "saved centrally",
          expectedRevision: 0,
        }),
      })
      expect(state.status).toBe(200)
      expect((yield* call("/user-state?namespace=drafts&key=integration", { headers })).status).toBe(200)
      const preview = yield* json(
        "/global/preview/static",
        { directory: project, html: "<html><body>Isolated smoke preview</body></html>" },
        cookie,
      )
      expect(preview.status).toBe(200)
      const previewBody = yield* Effect.promise(() => preview.json())
      const isolated = new URL(previewBody.url)
      const previewCall = (route: string, previewCookie?: string) =>
        Effect.promise(() =>
          fetch(`http://127.0.0.1:${process.env.OPENCODE_PREVIEW_PORT}${route}`, {
            redirect: "manual",
            headers: { host: isolated.host, ...(previewCookie ? { cookie: previewCookie } : {}) },
          }),
        )
      const exchange = yield* previewCall(`${isolated.pathname}${isolated.search}`)
      expect(exchange.status).toBe(303)
      const previewCookie = exchange.headers.get("set-cookie")!.split(";")[0]
      const html = yield* previewCall(isolated.pathname, previewCookie)
      expect(html.status).toBe(200)
      expect(yield* Effect.promise(() => html.text())).toContain("omai-visual-bridge")
      expect((yield* previewCall("/auth/me", cookie)).status).toBe(404)
      yield* Effect.promise(async () => {
        await mkdir(path.join(project, "node_modules"))
        await writeFile(path.join(project, "bun.lock"), "")
        await writeFile(
          path.join(project, "package.json"),
          JSON.stringify({ name: "central-live-preview", scripts: { dev: "bun dev-server.ts" } }),
        )
        await writeFile(
          path.join(project, "dev-server.ts"),
          [
            'import { createServer } from "node:http"',
            'const server = createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end("<html><body>Live preview; credential=" + Boolean(process.env.OPENCODE_DATABASE_URL) + "; cookie=" + Boolean(request.headers.cookie) + "</body></html>") })',
            'server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready on http://127.0.0.1:" + server.address().port))',
          ].join("\n"),
        )
      })
      const { stopDevServer } = yield* Effect.promise(() => import("../../src/preview/server"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopDevServer(project)
        }),
      )
      const live = yield* json("/global/preview/start", { directory: project }, cookie)
      expect(live.status).toBe(200)
      const liveBody = yield* Effect.promise(() => live.json())
      const liveURL = new URL(liveBody.url)
      expect(liveURL.origin).toBe(process.env.OPENCODE_PREVIEW_URL!)
      const liveExchange = yield* previewCall(`${liveURL.pathname}${liveURL.search}`)
      expect(liveExchange.status).toBe(303)
      const liveCookie = liveExchange.headers.get("set-cookie")!.split(";")[0]
      const livePage = yield* previewCall(liveURL.pathname, liveCookie)
      expect(livePage.status).toBe(200)
      const liveHtml = yield* Effect.promise(() => livePage.text())
      expect(liveHtml).toContain("Live preview; credential=false; cookie=false")
      expect(liveHtml).toContain("omai-visual-bridge")
      expect((yield* call(liveURL.pathname, { headers: { cookie } })).status).toBe(404)
      expect((yield* json("/global/preview/stop", { directory: project }, cookie)).status).toBe(200)
      expect((yield* json("/auth/logout", {}, cookie)).status).toBe(200)
      expect((yield* call("/auth/me", { headers: { cookie } })).status).toBe(401)
      expect((yield* previewCall(isolated.pathname, previewCookie)).status).toBe(401)
    }),
  60_000,
)
