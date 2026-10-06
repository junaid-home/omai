import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AuthSessionTable } from "../src/auth-session/sql"
import { Database } from "../src/database/database"
import { InstanceStateEncryption } from "../src/instance-state/encryption"
import { InstanceStateStore } from "../src/instance-state/store"
import { PreviewCapability } from "../src/preview-capability"
import { UserTable } from "../src/user/sql"

const target: PreviewCapability.Target = {
  userID: crypto.randomUUID(),
  sessionID: crypto.randomUUID(),
  port: 5173,
  directory: "/mounted/workspaces/project",
  origin: "https://preview.example.invalid",
}
const make = () =>
  ManagedRuntime.make(
    PreviewCapability.layer.pipe(
      Layer.provideMerge(InstanceStateStore.layerFromKey(InstanceStateEncryption.keyFromEnvironment())),
      Layer.provideMerge(Database.layerFromConfig(Database.configFromEnvironment())),
    ),
  )
const first = make()
const second = make()

beforeEach(() =>
  first.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.insert(UserTable).values({
        id: target.userID,
        username: `preview-${target.userID}`,
        email: `${target.userID}@example.invalid`,
        password_hash: "not-a-login-credential",
      })
      yield* database.db.insert(AuthSessionTable).values({
        id: target.sessionID,
        user_id: target.userID,
        time_created: Date.now(),
        time_expires: Date.now() + 60 * 60_000,
      })
    }),
  ),
)
afterAll(() => Promise.all([first.dispose(), second.dispose()]))

const issue = Effect.gen(function* () {
  const capabilities = yield* PreviewCapability.Service
  return yield* capabilities.issue(target)
})
const exchange = (token: string, port = target.port, origin = target.origin) =>
  Effect.gen(function* () {
    const capabilities = yield* PreviewCapability.Service
    return yield* capabilities.exchange(token, port, origin)
  })
const validate = (token: string, port = target.port, origin = target.origin) =>
  Effect.gen(function* () {
    const capabilities = yield* PreviewCapability.Service
    return yield* capabilities.validate(token, port, origin)
  })

describe("separate-origin preview capabilities", () => {
  test("exchanges bootstrap exactly once across competing PostgreSQL pools", async () => {
    const bootstrap = await first.runPromise(issue)
    expect(bootstrap.token).toMatch(/^[a-zA-Z0-9_-]{43}$/)
    const grants = await Promise.all([first, second].map((runtime) => runtime.runPromise(exchange(bootstrap.token))))
    expect(grants.filter(Boolean)).toHaveLength(1)
    const grant = grants.find((value) => value !== undefined)!
    expect(grant.cookie).not.toEqual(bootstrap.token)
    expect(await first.runPromise(validate(bootstrap.token))).toBeUndefined()
    expect(await second.runPromise(validate(grant.cookie))).toMatchObject(target)
    expect(await first.runPromise(exchange(bootstrap.token))).toBeUndefined()
  })

  test("binds bootstrap and cookies to the configured preview origin and port", async () => {
    const bootstrap = await first.runPromise(issue)
    expect(await first.runPromise(exchange(bootstrap.token, 5174))).toBeUndefined()
    expect(await first.runPromise(exchange(bootstrap.token, 5173, "https://main.example.invalid"))).toBeUndefined()
    const grant = await first.runPromise(exchange(bootstrap.token))
    expect(grant).toBeDefined()
    expect(await second.runPromise(validate(grant!.cookie, 5174))).toBeUndefined()
    expect(await second.runPromise(validate(grant!.cookie, 5173, "https://main.example.invalid"))).toBeUndefined()
    expect(await second.runPromise(validate("not-a-capability"))).toBeUndefined()
  })

  test("checks session ownership, expiry and revocation on every access", async () => {
    const bootstrap = await first.runPromise(issue)
    const grant = await first.runPromise(exchange(bootstrap.token))
    await first.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db
          .update(AuthSessionTable)
          .set({ time_revoked: Date.now() })
          .where(eq(AuthSessionTable.id, target.sessionID))
      }),
    )
    expect(await second.runPromise(validate(grant!.cookie))).toBeUndefined()
    expect(
      await first.runPromise(
        issue.pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "unexpected" })),
      ),
    ).toBe("PreviewCapability.Invalid")
    await first.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db
          .update(AuthSessionTable)
          .set({ time_revoked: null, time_expires: Date.now() - 1 })
          .where(eq(AuthSessionTable.id, target.sessionID))
      }),
    )
    expect(await second.runPromise(validate(grant!.cookie))).toBeUndefined()
  })

  test("refreshes an active idle capability and never extends past its auth session", async () => {
    const bootstrap = await first.runPromise(issue)
    const grant = (await first.runPromise(exchange(bootstrap.token)))!
    const sessionExpiresAt = Date.now() + 10 * 60_000
    await first.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* InstanceStateStore.Service
        yield* database.db
          .update(AuthSessionTable)
          .set({ time_expires: sessionExpiresAt })
          .where(eq(AuthSessionTable.id, target.sessionID))
        yield* store.write("preview-capabilities", createHash("sha256").update(grant.cookie).digest("hex"), {
          ...target,
          kind: "cookie",
          expiresAt: Date.now() + 60_000,
        })
      }),
    )
    expect((await second.runPromise(validate(grant.cookie)))?.expiresAt).toBe(sessionExpiresAt)
  })

  test("expires stale capabilities, prunes them and supports static previews", async () => {
    const bootstrap = await first.runPromise(
      Effect.gen(function* () {
        const capabilities = yield* PreviewCapability.Service
        return yield* capabilities.issue({
          ...target,
          port: 0,
          directory: "/mounted/workspaces/project/.OMAI+/preview/static.html",
        })
      }),
    )
    const grant = (await first.runPromise(exchange(bootstrap.token, 0)))!
    expect(await first.runPromise(validate(grant.cookie, 0))).toMatchObject({
      port: 0,
      directory: "/mounted/workspaces/project/.OMAI+/preview/static.html",
    })
    await first.runPromise(
      Effect.gen(function* () {
        const store = yield* InstanceStateStore.Service
        yield* store.write("preview-capabilities", createHash("sha256").update(grant.cookie).digest("hex"), {
          ...target,
          kind: "cookie",
          expiresAt: Date.now() - 1,
        })
      }),
    )
    expect(await second.runPromise(validate(grant.cookie))).toBeUndefined()
    expect(
      await first.runPromise(
        Effect.gen(function* () {
          const capabilities = yield* PreviewCapability.Service
          return yield* capabilities.prune()
        }),
      ),
    ).toBe(1)
  })
})
