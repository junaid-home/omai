import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { and, eq, gt, isNull } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { AuthSessionTable } from "./auth-session/sql"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { InstanceStateStore } from "./instance-state/store"

const namespace = "preview-capabilities"
export const bootstrapLifetime = 60_000
export const idleLifetime = 15 * 60_000
const refreshWindow = 5 * 60_000

const Capability = Schema.Struct({
  kind: Schema.Literals(["bootstrap", "cookie", "consumed"]),
  userID: Schema.String,
  sessionID: Schema.String,
  port: Schema.Number,
  directory: Schema.String,
  origin: Schema.String,
  expiresAt: Schema.Number,
})
type Capability = typeof Capability.Type

export interface Target {
  readonly userID: string
  readonly sessionID: string
  /** Zero identifies a persisted static preview; live upstream ports are positive. */
  readonly port: number
  readonly directory: string
  readonly origin: string
}

export interface Access extends Target {
  readonly expiresAt: number
}

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("PreviewCapability.Invalid", {}) {}
export class InvalidTarget extends Schema.TaggedErrorClass<InvalidTarget>()("PreviewCapability.InvalidTarget", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly issue: (
    target: Target,
  ) => Effect.Effect<{ token: string; expiresAt: number }, Invalid | InvalidTarget | InstanceStateStore.StateError>
  readonly exchange: (
    token: string,
    port: number,
    origin: string,
  ) => Effect.Effect<(Access & { cookie: string }) | undefined, InstanceStateStore.StateError>
  readonly validate: (
    cookie: string,
    port: number,
    origin: string,
  ) => Effect.Effect<Access | undefined, InstanceStateStore.StateError>
  readonly prune: () => Effect.Effect<number, InstanceStateStore.StateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PreviewCapability") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceStateStore.Service
    const database = yield* Database.Service

    const activeSession = Effect.fn("PreviewCapability.activeSession")(function* (target: Target, now: number) {
      const session = yield* database.db
        .select({ expiresAt: AuthSessionTable.time_expires })
        .from(AuthSessionTable)
        .where(
          and(
            eq(AuthSessionTable.id, target.sessionID),
            eq(AuthSessionTable.user_id, target.userID),
            isNull(AuthSessionTable.time_revoked),
            gt(AuthSessionTable.time_expires, now),
          ),
        )
        .pipe(Database.first, Effect.orDie)
      if (!session) return yield* new Invalid({})
      return session
    })

    const checked = Effect.fn("PreviewCapability.checked")(function* (
      value: unknown,
      kind: Capability["kind"],
      port: number,
      origin: string,
      now: number,
    ) {
      const capability = decode(value)
      if (
        !capability ||
        capability.kind !== kind ||
        capability.port !== port ||
        capability.origin !== origin ||
        capability.expiresAt <= now
      ) {
        return yield* new Invalid({})
      }
      return { capability, session: yield* activeSession(capability, now) }
    })

    return Service.of({
      issue: Effect.fn("PreviewCapability.issue")(function* (target) {
        const problem = targetProblem(target)
        if (problem) return yield* new InvalidTarget({ message: problem })
        const now = yield* Clock.currentTimeMillis
        const session = yield* activeSession(target, now)
        const token = randomBytes(32).toString("base64url")
        const expiresAt = Math.min(session.expiresAt, now + bootstrapLifetime)
        yield* state.write(namespace, digest(token), { ...target, expiresAt, kind: "bootstrap" })
        return { token, expiresAt }
      }),
      exchange: Effect.fn("PreviewCapability.exchange")(
        function* (token, port, origin) {
          if (!validToken(token)) return undefined
          const cookie = randomBytes(32).toString("base64url")
          const now = yield* Clock.currentTimeMillis
          const consumed = yield* state.update(namespace, digest(token), (value) =>
            Effect.gen(function* () {
              const grant = yield* checked(value, "bootstrap", port, origin, now)
              const capability = {
                ...grant.capability,
                kind: "cookie" as const,
                expiresAt: Math.min(grant.session.expiresAt, now + idleLifetime),
              }
              // Both writes share the transaction held by update. A failed cookie
              // write leaves the bootstrap exchange available for an exact retry.
              yield* state.write(namespace, digest(cookie), capability)
              return { ...grant.capability, kind: "consumed" as const, cookieExpiresAt: capability.expiresAt }
            }),
          )
          return { ...access(consumed), expiresAt: consumed.cookieExpiresAt, cookie }
        },
        Effect.catchTag("PreviewCapability.Invalid", () => Effect.succeed(undefined)),
      ),
      validate: Effect.fn("PreviewCapability.validate")(
        function* (cookie, port, origin) {
          if (!validToken(cookie)) return undefined
          const now = yield* Clock.currentTimeMillis
          const grant = yield* checked(yield* state.read(namespace, digest(cookie)), "cookie", port, origin, now)
          if (grant.capability.expiresAt - now >= refreshWindow) {
            return {
              ...access(grant.capability),
              expiresAt: Math.min(grant.capability.expiresAt, grant.session.expiresAt),
            }
          }
          const refreshed = yield* state.update(namespace, digest(cookie), (value) =>
            Effect.gen(function* () {
              const latest = yield* checked(value, "cookie", port, origin, now)
              return { ...latest.capability, expiresAt: Math.min(latest.session.expiresAt, now + idleLifetime) }
            }),
          )
          return access(refreshed)
        },
        Effect.catchTag("PreviewCapability.Invalid", () => Effect.succeed(undefined)),
      ),
      prune: Effect.fn("PreviewCapability.prune")(function* () {
        const now = yield* Clock.currentTimeMillis
        const keys = yield* state.keys(namespace)
        const removed = yield* Effect.forEach(
          keys,
          (key) =>
            Effect.gen(function* () {
              const capability = decode(yield* state.read(namespace, key))
              if (capability && capability.expiresAt > now) return 0
              const current = yield* state.update(namespace, key, (value) => {
                const latest = decode(value)
                return Effect.succeed(latest && latest.expiresAt > now ? value : undefined)
              })
              return current === undefined ? 1 : 0
            }),
          { concurrency: 4 },
        )
        return removed.reduce<number>((total, value) => total + value, 0)
      }),
    })
  }),
)

function digest(token: string) {
  return createHash("sha256").update(token, "ascii").digest("hex")
}

function validToken(token: string) {
  return /^[a-zA-Z0-9_-]{43}$/.test(token)
}

function decode(value: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Capability)(value))
}

function access(capability: Capability): Access {
  return {
    userID: capability.userID,
    sessionID: capability.sessionID,
    port: capability.port,
    directory: capability.directory,
    origin: capability.origin,
    expiresAt: capability.expiresAt,
  }
}

function targetProblem(target: Target) {
  if (!Number.isInteger(target.port) || target.port < 0 || target.port > 65535) return "Invalid preview port"
  if (!target.userID || !target.sessionID) return "An authenticated session is required"
  if (
    !path.isAbsolute(target.directory) ||
    path.normalize(target.directory) !== target.directory ||
    target.directory.includes("\u0000")
  ) {
    return "Preview target must be a canonical absolute path"
  }
  const origin = URL.parse(target.origin)
  if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.origin !== target.origin)
    return "Invalid preview origin"
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, InstanceStateStore.node] })

export * as PreviewCapability from "./preview-capability"
