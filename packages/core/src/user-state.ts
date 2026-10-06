import { and, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Authentication } from "./authentication"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { UserStateTable } from "./user-state/sql"

export const namespaces = [
  "preferences",
  "drafts",
  "comments",
  "history",
  "notifications",
  "permissions",
  "workspace",
  "ui",
] as const

export const Namespace = Schema.Literals(namespaces)
export type Namespace = typeof Namespace.Type
export const keyLimit = 2048
export const valueLimit = 2 * 1024 * 1024

export const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(keyLimit))
export const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const Value = Schema.NullOr(Schema.String.check(Schema.isMaxLength(valueLimit)))
export const Query = Schema.Struct({ namespace: Namespace, key: Key })
export type Query = typeof Query.Type
export const Write = Schema.Struct({ ...Query.fields, expectedRevision: Revision, value: Value })
export type Write = typeof Write.Type
export const Snapshot = Schema.Struct({ revision: Revision, value: Value })
export type Snapshot = typeof Snapshot.Type

export class Unauthenticated extends Schema.TaggedErrorClass<Unauthenticated>()("UserState.Unauthenticated", {}) {}
export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("UserState.InvalidInput", {
  message: Schema.String,
}) {}
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("UserState.Conflict", {
  current: Snapshot,
}) {}

export interface Interface {
  readonly get: (input: Query) => Effect.Effect<Snapshot, Unauthenticated | InvalidInput>
  readonly put: (input: Write) => Effect.Effect<Snapshot, Unauthenticated | InvalidInput | Conflict>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/UserState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const columns = { revision: UserStateTable.revision, value: UserStateTable.value }
    const owner = Effect.fn("UserState.owner")(function* () {
      const principal = yield* Authentication.Current
      if (!principal) return yield* new Unauthenticated({})
      return principal.userID
    })
    const select = (userID: string, input: Query) =>
      and(
        eq(UserStateTable.user_id, userID),
        eq(UserStateTable.namespace, input.namespace),
        eq(UserStateTable.key, input.key),
      )
    const current = Effect.fn("UserState.current")(function* (userID: string, input: Query) {
      return (
        (yield* database.db
          .select(columns)
          .from(UserStateTable)
          .where(select(userID, input))
          .pipe(Database.first, Effect.orDie)) ?? { revision: 0, value: null }
      )
    })

    return Service.of({
      get: Effect.fn("UserState.get")(function* (input) {
        const userID = yield* owner()
        const problem = validate(input)
        if (problem) return yield* new InvalidInput({ message: problem })
        return yield* current(userID, input)
      }),
      put: Effect.fn("UserState.put")(function* (input) {
        const userID = yield* owner()
        const problem = validate(input)
        if (problem) return yield* new InvalidInput({ message: problem })
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
          return yield* new InvalidInput({ message: "expectedRevision must be a non-negative safe integer" })
        }
        if (input.expectedRevision === Number.MAX_SAFE_INTEGER) {
          return yield* new InvalidInput({ message: "The revision counter is exhausted" })
        }
        if (input.value !== null && !validText(input.value, valueLimit)) {
          return yield* new InvalidInput({
            message: `value must be null or valid UTF-8 text of at most ${valueLimit} bytes`,
          })
        }
        const now = yield* Clock.currentTimeMillis
        const change = {
          value: input.value,
          revision: input.expectedRevision + 1,
          time_updated: now,
          time_deleted: input.value === null ? now : null,
        }

        // The unique key and conditional UPDATE are the arbitration point across
        // processes. Deletions retain a revision, so stale clients cannot recreate
        // a removed value with an obsolete revision-zero write.
        const saved =
          input.expectedRevision === 0
            ? yield* database.db
                .insert(UserStateTable)
                .values({ user_id: userID, namespace: input.namespace, key: input.key, ...change })
                .onConflictDoNothing({ target: [UserStateTable.user_id, UserStateTable.namespace, UserStateTable.key] })
                .returning(columns)
                .pipe(Database.first, Effect.orDie)
            : yield* database.db
                .update(UserStateTable)
                .set(change)
                .where(and(select(userID, input), eq(UserStateTable.revision, input.expectedRevision)))
                .returning(columns)
                .pipe(Database.first, Effect.orDie)
        if (saved) return saved
        return yield* new Conflict({ current: yield* current(userID, input) })
      }),
    })
  }),
)

function validate(input: Query) {
  if (!namespaces.includes(input.namespace)) return "Unsupported user-state namespace"
  if (!input.key || !validText(input.key, keyLimit)) return `key must be valid UTF-8 text of 1-${keyLimit} bytes`
}

function validText(value: string, limit: number) {
  return (
    typeof value === "string" &&
    !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) &&
    Buffer.byteLength(value, "utf8") <= limit
  )
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

export * as UserState from "./user-state"
