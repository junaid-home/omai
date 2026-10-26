import { CentralStorage } from "@opencode-ai/core/storage/central"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { decodeDirectory, WorkspaceRouteContext } from "./workspace-routing"
import { vmProjectsRoot } from "@/control-plane/vm-projects"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const decoded = decodeDirectory(route.directory)
    const vmRoot = (yield* Effect.sync(() => vmProjectsRoot())) as string | undefined
    const directory =
      vmRoot && (decoded === vmRoot || decoded.startsWith(vmRoot + "/"))
        ? decoded
        : yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(decoded).pipe(Effect.option)).pipe(
            Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
          )
    if (!directory) return HttpServerResponse.empty({ status: 403 })
    const ctx = yield* store.load({ directory })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
