import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStateStore } from "@opencode-ai/core/instance-state/store"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Effect, Layer, Schema } from "effect"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {
  static isInstance(input: unknown): input is NotFoundError {
    return input instanceof NotFoundError
  }
}

export type Error = InstanceStateStore.StateError | NotFoundError | FSUtil.Error

export interface Interface {
  readonly remove: (key: string[]) => Effect.Effect<void, InstanceStateStore.StateError>
  readonly read: <T>(key: string[]) => Effect.Effect<T, Error>
  readonly update: <T>(key: string[], fn: (draft: T) => void) => Effect.Effect<T, Error>
  readonly write: <T>(key: string[], content: T) => Effect.Effect<void, InstanceStateStore.StateError>
  readonly list: (prefix: string[]) => Effect.Effect<string[][], InstanceStateStore.StateError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Storage") {}

const decodeKey = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))
const namespace = "legacy-storage"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceStateStore.Service
    const missing = (key: string[]) => new NotFoundError({ message: `Resource not found: ${key.join("/")}` })

    return Service.of({
      remove: (key) => state.remove(namespace, JSON.stringify(key)),
      read: <T>(key: string[]) =>
        state
          .read(namespace, JSON.stringify(key))
          .pipe(
            Effect.flatMap((value) => (value === undefined ? Effect.fail(missing(key)) : Effect.succeed(value as T))),
          ),
      update: <T>(key: string[], change: (draft: T) => void) =>
        state.update(namespace, JSON.stringify(key), (value) =>
          Effect.gen(function* () {
            if (value === undefined) return yield* missing(key)
            const draft = value as T
            change(draft)
            return draft
          }),
        ),
      write: (key, content) => state.write(namespace, JSON.stringify(key), content),
      list: (prefix) =>
        state.keys(namespace).pipe(
          Effect.map((keys) =>
            keys
              .map((key) => [...decodeKey(key)])
              .filter((key) => prefix.every((part, index) => key[index] === part))
              .toSorted((left, right) => left.join("/").localeCompare(right.join("/"))),
          ),
        ),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [InstanceStateStore.node] })

export * as Storage from "./storage"
