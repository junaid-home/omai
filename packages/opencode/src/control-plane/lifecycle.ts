import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Context, Deferred, Effect, Layer, Schedule, Semaphore } from "effect"
import { Workspace } from "./workspace"
import { WorkspaceAdapterRuntime } from "./workspace-adapter-runtime"

function env(key: string, fallback: number) {
  const value = Number(process.env[key] ?? fallback)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

const idleMs = () => env("OPENCODE_WORKSPACE_IDLE_MS", 60_000)
const wakeTimeoutMs = () => env("NORTHFLANK_WAKE_TIMEOUT_MS", 180_000)

type Phase = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING"

export interface Interface {
  readonly touch: (workspaceID: WorkspaceV2.ID) => Effect.Effect<void>
  readonly ensureRunning: (workspace: Workspace.Info) => Effect.Effect<void>
  readonly sweep: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/control-plane/Lifecycle") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const bootedAt = Date.now()
    const phases = new Map<WorkspaceV2.ID, Phase>()
    const activity = new Map<WorkspaceV2.ID, number>()
    const locks = new Map<WorkspaceV2.ID, Semaphore.Semaphore>()
    const waking = new Map<WorkspaceV2.ID, Deferred.Deferred<void, never>>()

    const lock = (id: WorkspaceV2.ID) => {
      const hit = locks.get(id)
      if (hit) return hit
      const next = Semaphore.makeUnsafe(1)
      locks.set(id, next)
      return next
    }

    const touch = Effect.fn("Lifecycle.touch")((workspaceID: WorkspaceV2.ID) =>
      Effect.sync(() => {
        activity.set(workspaceID, Date.now())
        if (!phases.has(workspaceID)) phases.set(workspaceID, "RUNNING")
      }),
    )

    const ensureRunning = Effect.fn("Lifecycle.ensureRunning")(function* (space: Workspace.Info) {
      if (!WorkspaceAdapterRuntime.lifecycleAdapter(space)) return
      const id = space.id
      const alreadySynced = yield* workspace.isSynced(id)
      if (alreadySynced) {
        if (phases.get(id) === "RUNNING") {
          activity.set(id, Date.now())
          return
        }
        yield* Effect.sleep(250)
        if (yield* workspace.isSynced(id)) {
          phases.set(id, "RUNNING")
          activity.set(id, Date.now())
          return
        }
      }
      activity.set(id, Date.now())
      const entry = yield* Effect.sync(() => {
        const pending = waking.get(id)
        if (pending) return { deferred: pending, owner: false }
        const deferred = Deferred.makeUnsafe<void, never>()
        waking.set(id, deferred)
        return { deferred, owner: true }
      })
      if (!entry.owner) return yield* Deferred.await(entry.deferred)

      phases.set(id, "STARTING")
      const wake = lock(id).withPermits(1)(
        Effect.gen(function* () {
          yield* WorkspaceAdapterRuntime.start(space).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workspace wake failed", { workspaceID: id, error: String(cause) }),
            ),
          )
          const deadline = Date.now() + wakeTimeoutMs()
          while (Date.now() < deadline) {
            if (yield* workspace.isSynced(id)) {
              phases.set(id, "RUNNING")
              activity.set(id, Date.now())
              return
            }
            yield* Effect.sleep(250)
          }
          yield* Effect.logWarning("workspace wake timed out", { workspaceID: id })
          activity.set(id, Date.now())
          phases.set(id, "RUNNING")
        }),
      )
      yield* entry.deferred.pipe(
        Deferred.complete(wake),
        Effect.ensuring(Effect.sync(() => waking.delete(id))),
        Effect.forkDetach({ startImmediately: true }),
      )
      return yield* Deferred.await(entry.deferred)
    })

    const sweep = Effect.gen(function* () {
      const rows = yield* workspace.all()
      const idle = idleMs()
      yield* Effect.forEach(rows, (space) =>
        Effect.gen(function* () {
          if (!WorkspaceAdapterRuntime.lifecycleAdapter(space)) return
          const id = space.id
          if (phases.get(id) === "STARTING") return
          const fresh = () => Date.now() - (activity.get(id) ?? bootedAt) < idle
          if (fresh()) return
          if (!(yield* workspace.isSyncing(id))) {
            phases.set(id, "STOPPED")
            return
          }
          yield* lock(id).withPermits(1)(
            Effect.gen(function* () {
              if (fresh()) return
              if (!(yield* workspace.isSyncing(id))) {
                phases.set(id, "STOPPED")
                return
              }
              const report = yield* WorkspaceAdapterRuntime.busy(space).pipe(
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
              if (report?.busy) {
                activity.set(id, Date.now())
                phases.set(id, "RUNNING")
                return
              }
              phases.set(id, "STOPPING")
              const stopped = yield* WorkspaceAdapterRuntime.stop(space).pipe(
                Effect.map(() => true),
                Effect.catchCause((cause) =>
                  Effect.logWarning("workspace stop failed", { workspaceID: id, error: String(cause) }).pipe(
                    Effect.as(false),
                  ),
                ),
              )
              phases.set(id, "STOPPED")
              activity.set(id, Date.now())
              if (stopped) {
                yield* Effect.logInfo("workspace suspended", { workspaceID: id, reasons: report?.reasons ?? [] })
              }
            }),
          )
        }),
      )
    })

    const interval = Math.max(env("OPENCODE_WORKSPACE_SWEEP_MS", 5_000), 10)
    yield* sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("workspace sweep failed", { error: String(cause) })),
      Effect.repeat(Schedule.spaced(interval)),
      Effect.forkScoped,
    )

    return Service.of({ touch, ensureRunning, sweep })
  }),
)

export * as Lifecycle from "./lifecycle"
