import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { registerAdapter } from "../../src/control-plane/adapters"
import { Lifecycle } from "../../src/control-plane/lifecycle"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { ProvisionState } from "../../src/control-plane/provision-state"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("proj_lifecycle_wake")

const adapter: WorkspaceAdapter = {
  name: "wake-test",
  description: "lifecycle-managed test adapter",
  configure: (info) => info,
  create: async () => {},
  remove: async () => {},
  target: () => ({ type: "remote", url: "http://127.0.0.1:1" }),
  start: async () => {},
  stop: async () => {},
  busy: async () => ({ busy: false, reasons: [] }),
}

const space: Workspace.Info = {
  id: WorkspaceV2.ID.ascending(),
  type: "wake-test",
  name: "wake",
  branch: null,
  directory: null,
  extra: null,
  projectID,
  timeUsed: 0,
}

const it = testEffect(Layer.empty)

function fakeWorkspace(overrides: Partial<Workspace.Interface>) {
  return Workspace.Service.of({
    create: () => Effect.die("unused"),
    insert: () => Effect.die("unused"),
    provisionVM: () => Effect.die("unused"),
    setExtra: () => Effect.die("unused"),
    stopSync: () => Effect.void,
    sessionWarp: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    syncList: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    isSyncing: () => Effect.succeed(true),
    isSynced: () => Effect.succeed(false),
    waitForSync: () => Effect.die("unused"),
    startWorkspaceSyncing: () => Effect.die("unused"),
    getByDirectory: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    startSync: () => Effect.void,
    ...overrides,
  })
}

const lifecycleWith = (workspace: Workspace.Interface) =>
  Lifecycle.Service.pipe(
    Effect.provide(Lifecycle.layer.pipe(Layer.provide(Layer.succeed(Workspace.Service, workspace)))),
  )

function withEnv<A, E, R>(env: Record<string, string>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
      Object.assign(process.env, env)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

describe("control-plane lifecycle", () => {
  it.live("keeps retrying the sync connection while a VM wakes instead of waiting out backoff", () =>
    Effect.gen(function* () {
      registerAdapter(projectID, "wake-test", adapter)
      const retries = yield* Ref.make(0)
      // The VM answers only once the loop has been retried twice: a sync loop
      // left alone in exponential backoff would not reconnect within the wake.
      const workspace = Workspace.Service.of({
        create: () => Effect.die("unused"),
        insert: () => Effect.die("unused"),
        provisionVM: () => Effect.die("unused"),
        setExtra: () => Effect.die("unused"),
        stopSync: () => Effect.void,
        sessionWarp: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        syncList: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        status: () => Effect.die("unused"),
        isSyncing: () => Effect.succeed(true),
        isSynced: () => Ref.get(retries).pipe(Effect.map((count) => count >= 2)),
        waitForSync: () => Effect.die("unused"),
        startWorkspaceSyncing: () => Effect.die("unused"),
        getByDirectory: () => Effect.succeed(undefined),
        all: () => Effect.succeed([]),
        startSync: () => Ref.update(retries, (count) => count + 1),
      })
      const lifecycle = yield* Lifecycle.Service.pipe(
        Effect.provide(Lifecycle.layer.pipe(Layer.provide(Layer.succeed(Workspace.Service, workspace)))),
      )

      const started = Date.now()
      yield* lifecycle.ensureRunning(space)

      expect(yield* Ref.get(retries)).toBe(2)
      expect(Date.now() - started).toBeLessThan(5_000)
    }),
  )

  it.live("sweep never stops a workspace whose provision is not ready", () =>
    withEnv(
      { OPENCODE_WORKSPACE_IDLE_MS: "0", OPENCODE_WORKSPACE_SWEEP_MS: "100000", OPENCODE_PROVISION_RECONCILE: "true" },
      Effect.gen(function* () {
        const stops = yield* Ref.make(0)
        registerAdapter(projectID, "sweep-test", {
          ...adapter,
          stop: async () => Effect.runSync(Ref.update(stops, (count) => count + 1)),
        })
        const provisioning: Workspace.Info = {
          ...space,
          id: WorkspaceV2.ID.ascending(),
          type: "sweep-test",
          extra: ProvisionState.write(
            null,
            ProvisionState.begin({ kind: "new", mode: "empty", now: Date.now(), bootDeadlineMs: 60_000 }),
          ),
        }
        const ready: Workspace.Info = { ...provisioning, id: WorkspaceV2.ID.ascending(), extra: null }
        const lifecycle = yield* lifecycleWith(fakeWorkspace({ all: () => Effect.succeed([provisioning, ready]) }))

        yield* lifecycle.sweep

        // Only the legacy/ready row may be suspended.
        expect(yield* Ref.get(stops)).toBe(1)
      }),
    ),
  )

  it.live("a process that does not own VM management never suspends VMs", () =>
    withEnv(
      { OPENCODE_WORKSPACE_IDLE_MS: "0", OPENCODE_WORKSPACE_SWEEP_MS: "100000", OPENCODE_PROVISION_RECONCILE: "false" },
      Effect.gen(function* () {
        const stops = yield* Ref.make(0)
        registerAdapter(projectID, "sweep-owner-test", {
          ...adapter,
          stop: async () => Effect.runSync(Ref.update(stops, (count) => count + 1)),
        })
        const idle: Workspace.Info = { ...space, id: WorkspaceV2.ID.ascending(), type: "sweep-owner-test" }
        const lifecycle = yield* lifecycleWith(fakeWorkspace({ all: () => Effect.succeed([idle]) }))

        yield* lifecycle.sweep

        // A laptop sharing the production database must not pause VMs that
        // production users are working in.
        expect(yield* Ref.get(stops)).toBe(0)
      }),
    ),
  )
})
