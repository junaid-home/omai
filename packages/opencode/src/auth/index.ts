import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { InstanceStateStore } from "@opencode-ai/core/instance-state/store"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceStateStore.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      const data =
        (yield* state.read("provider-auth", "all").pipe(Effect.mapError(fail("Failed to read auth data")))) ?? {}
      if (typeof data !== "object" || data === null || Array.isArray(data))
        return yield* new AuthError({ message: "Invalid stored auth data" })
      return Record.filterMap(data as Record<string, unknown>, (value) =>
        Result.fromOption(decode(value), () => undefined),
      )
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      yield* state
        .update("provider-auth", "all", () =>
          Effect.gen(function* () {
            const data = yield* all()
            if (norm !== key) delete data[key]
            delete data[norm + "/"]
            return { ...data, [norm]: info }
          }),
        )
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      yield* state
        .update("provider-auth", "all", () =>
          Effect.gen(function* () {
            const data = yield* all()
            delete data[key]
            delete data[norm]
            delete data[norm + "/"]
            return data
          }),
        )
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [InstanceStateStore.node] })

export * as Auth from "."
