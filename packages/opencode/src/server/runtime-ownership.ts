import { Database } from "@opencode-ai/core/database/database"
import { CentralStorage } from "@opencode-ai/core/storage/central"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"

/** A central instance runs one complete server/runtime, including PTYs and background work. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!CentralStorage.current()) return
    const { db } = yield* Database.Service
    yield* Effect.promise(() => CentralStorage.check())
    const ownership = yield* Database.claimRuntime(db, Database.configFromEnvironment().instanceID)
    yield* ownership.lost.pipe(
      Effect.catchCause(() =>
        Effect.logFatal("Runtime database ownership lost; stopping the instance").pipe(
          Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),
        ),
      ),
      Effect.forkScoped,
    )
  }).pipe(Effect.orDie),
)

export const node = LayerNode.make({ name: "central-runtime-ownership", layer, deps: [Database.node] })

export * as RuntimeOwnership from "./runtime-ownership"
