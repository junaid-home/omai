import { Effect, Schema } from "effect"
import { WorkspaceGoneError } from "@opencode-ai/northflank"
import { EffectBridge } from "@/effect/bridge"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { getAdapter } from "./adapters"
import type { WorkspaceAdapter, WorkspaceInfo } from "./types"

/** The backing VM no longer exists, so this workspace must be re-provisioned. */
export class WorkspaceGone extends Schema.TaggedErrorClass<WorkspaceGone>()("WorkspaceGone", {
  workspaceID: Schema.String,
  message: Schema.String,
}) {}

const context = Effect.gen(function* () {
  return {
    instance: yield* InstanceRef,
    workspaceID: yield* WorkspaceRef,
  }
})

export const target = (info: WorkspaceInfo) =>
  Effect.gen(function* () {
    const adapter = getAdapter(info.projectID, info.type)
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => adapter.target(info, ctx))
  })

/**
 * `target`, but a VM that no longer exists is a typed `WorkspaceGone` failure
 * instead of a defect, so the open path can drop the stranded row and
 * re-provision rather than latching a permanent broken-sync 503.
 */
export const targetOrGone = (info: WorkspaceInfo) =>
  target(info).pipe(
    Effect.catchDefect((defect) =>
      defect instanceof WorkspaceGoneError
        ? Effect.fail(
            new WorkspaceGone({ workspaceID: info.id, message: `MicroVM gone for workspace: ${info.id}` }),
          )
        : Effect.die(defect),
    ),
  )

export const configure = (adapter: WorkspaceAdapter, info: WorkspaceInfo) =>
  Effect.gen(function* () {
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => adapter.configure(info, ctx))
  })

export const create = (
  adapter: WorkspaceAdapter,
  info: WorkspaceInfo,
  env: Record<string, string | undefined>,
  from?: WorkspaceInfo,
) =>
  Effect.gen(function* () {
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => adapter.create(info, env, from, ctx))
  })

export const list = (adapter: WorkspaceAdapter) =>
  Effect.gen(function* () {
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => Promise.resolve(adapter.list?.(ctx) ?? []))
  })

export const remove = (info: WorkspaceInfo, options?: { keepVolume?: boolean }) =>
  Effect.gen(function* () {
    const adapter = getAdapter(info.projectID, info.type)
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() =>
      adapter.remove(info, options?.keepVolume ? { ...ctx, keepVolume: true } : ctx),
    )
  })

/** The adapter's view of a booting or running VM, or undefined when it cannot tell. */
export const health = (info: WorkspaceInfo) =>
  Effect.gen(function* () {
    const adapter = getAdapter(info.projectID, info.type)
    if (!adapter.health) return undefined
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => adapter.health!(info, ctx))
  })

/** An adapter exposing suspend/resume; `busy` stays optional (treated as never-busy). */
export type ManagedAdapter = WorkspaceAdapter & Required<Pick<WorkspaceAdapter, "start" | "stop">>

const isManaged = (adapter: WorkspaceAdapter): adapter is ManagedAdapter =>
  typeof adapter.start === "function" && typeof adapter.stop === "function"

/** The adapter's suspend/resume surface, or undefined when it has none (always-running target). */
export function lifecycleAdapter(info: WorkspaceInfo): ManagedAdapter | undefined {
  // getAdapter throws for rows whose type is no longer registered (plugin
  // removed); such rows are simply not lifecycle-managed.
  let adapter: WorkspaceAdapter
  try {
    adapter = getAdapter(info.projectID, info.type)
  } catch {
    return undefined
  }
  return isManaged(adapter) ? adapter : undefined
}

export const start = (info: WorkspaceInfo) =>
  Effect.gen(function* () {
    const adapter = lifecycleAdapter(info)
    if (!adapter) return
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => adapter.start(info, ctx))
  })

export const stop = (info: WorkspaceInfo) =>
  Effect.gen(function* () {
    const adapter = lifecycleAdapter(info)
    if (!adapter) return
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => adapter.stop(info, ctx))
  })

export const busy = (info: WorkspaceInfo) =>
  Effect.gen(function* () {
    const adapter = lifecycleAdapter(info)
    if (!adapter) return undefined
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => adapter.busy?.(info, ctx))
  })

export const relabel = (info: WorkspaceInfo) =>
  Effect.gen(function* () {
    const adapter = lifecycleAdapter(info)
    if (!adapter?.relabel) return
    const ctx = yield* context
    return yield* EffectBridge.fromPromise(() => adapter.relabel!(info, ctx))
  })

export * as WorkspaceAdapterRuntime from "./workspace-adapter-runtime"
