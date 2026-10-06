import { NodeHttpServer } from "@effect/platform-node"
import { AuthSessionTable } from "@opencode-ai/core/auth-session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceStateEncryption } from "@opencode-ai/core/instance-state/encryption"
import { InstanceStateStore } from "@opencode-ai/core/instance-state/store"
import { PreviewCapability } from "@opencode-ai/core/preview-capability"
import { UserTable } from "@opencode-ai/core/user/sql"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PreviewHttp } from "../../src/preview/http"
import { testEffect } from "../lib/effect"

const environment = new Map<string, string | undefined>()
beforeEach(() => {
  environment.set("OPENCODE_AUTH_MODE", process.env.OPENCODE_AUTH_MODE)
  process.env.OPENCODE_AUTH_MODE = "central"
  environment.set("OPENCODE_PUBLIC_URL", process.env.OPENCODE_PUBLIC_URL)
  process.env.OPENCODE_PUBLIC_URL = "https://app.example.test"
  environment.set("OPENCODE_PREVIEW_URL", process.env.OPENCODE_PREVIEW_URL)
  process.env.OPENCODE_PREVIEW_URL = "https://preview.example.test"
})
afterEach(() => {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  environment.clear()
})

const it = testEffect(
  HttpRouter.serve(PreviewHttp.routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(PreviewCapability.layer),
    Layer.provideMerge(InstanceStateStore.layerFromKey(InstanceStateEncryption.keyFromEnvironment())),
    Layer.provideMerge(Database.layerFromConfig(Database.configFromEnvironment())),
  ),
)
const get = (url: string, headers: Record<string, string> = {}) =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeaders({ host: "preview.example.test", ...headers }),
    HttpClient.execute,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  )
const setup = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "omai-preview-"))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  )
  const id = crypto.randomUUID()
  const userID = crypto.randomUUID()
  const sessionID = crypto.randomUUID()
  const file = path.join(directory, ".OMAI+", "preview", `${id}.html`)
  yield* Effect.promise(async () => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '<html><head></head><body><h1>Isolated preview</h1><img src="/image.svg"></body></html>')
    await writeFile(path.join(directory, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })
  const database = yield* Database.Service
  yield* database.db
    .insert(UserTable)
    .values({ id: userID, username: `preview-${userID}`, email: `${userID}@example.test`, password_hash: "unused" })
  yield* database.db
    .insert(AuthSessionTable)
    .values({ id: sessionID, user_id: userID, time_created: Date.now(), time_expires: Date.now() + 60_000 })
  const capabilities = yield* PreviewCapability.Service
  const grant = yield* capabilities.issue({
    userID,
    sessionID,
    port: 0,
    directory: file,
    origin: process.env.OPENCODE_PREVIEW_URL!,
  })
  return { id, sessionID, root: `/static/${id}/`, token: grant.token }
})

describe("dedicated preview HTTP listener", () => {
  it.live("exchanges a one-time bootstrap and renders bridged HTML and project assets", () =>
    Effect.gen(function* () {
      const preview = yield* setup
      expect((yield* get(preview.root)).status).toBe(401)
      const exchange = yield* get(`${preview.root}?ticket=${preview.token}`)
      expect(exchange.status).toBe(303)
      expect(exchange.headers.location).toBe(preview.root)
      expect(exchange.headers["set-cookie"]).toContain(`Path=${preview.root}`)
      expect(exchange.headers["set-cookie"]).toContain("HttpOnly; Secure")
      expect((yield* get(`${preview.root}?ticket=${preview.token}`)).status).toBe(401)
      const cookie = exchange.headers["set-cookie"]!.split(";")[0]
      const page = yield* get(preview.root, { cookie })
      expect(page.status).toBe(200)
      const html = yield* page.text
      expect(html).toContain("Isolated preview")
      expect(html).toContain('id="omai-visual-bridge"')
      expect(html).toContain(`${preview.root}image.svg`)
      expect(page.headers["content-security-policy"]).toBe("frame-ancestors https://app.example.test")
      expect(page.headers["cache-control"]).toBe("no-store")
      expect((yield* get(`${preview.root}image.svg`, { cookie })).status).toBe(200)
    }),
  )
  it.live("never serves the main API and binds access to the preview host", () =>
    Effect.gen(function* () {
      const preview = yield* setup
      const exchange = yield* get(`${preview.root}?ticket=${preview.token}`)
      const cookie = exchange.headers["set-cookie"]!.split(";")[0]
      for (const url of ["/auth/me", "/auth/login", "/user-state", "/session", "/file/image?path=/etc/passwd"])
        expect((yield* get(url, { cookie })).status).toBe(404)
      expect((yield* get(preview.root, { cookie, host: "app.example.test" })).status).toBe(404)
      expect((yield* get(preview.root, { cookie, origin: "https://unrelated.example.test" })).status).toBe(403)
    }),
  )
  it.live("revocation immediately invalidates preview cookies", () =>
    Effect.gen(function* () {
      const preview = yield* setup
      const exchange = yield* get(`${preview.root}?ticket=${preview.token}`)
      const cookie = exchange.headers["set-cookie"]!.split(";")[0]
      const database = yield* Database.Service
      yield* database.db
        .update(AuthSessionTable)
        .set({ time_revoked: Date.now() })
        .where(eq(AuthSessionTable.id, preview.sessionID))
      expect((yield* get(preview.root, { cookie })).status).toBe(401)
    }),
  )
})
