import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { registerAdapter } from "../../src/control-plane/adapters"
import { Lifecycle } from "../../src/control-plane/lifecycle"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
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

describe("control-plane lifecycle", () => {
  it.live("keeps retrying the sync connection while a VM wakes instead of waiting out backoff", () =>
    Effect.gen(function* () {
      registerAdapter(projectID, "wake-test", adapter)
      const retries = yield* Ref.make(0)
      // The VM answers only once the loop has been retried twice: a sync loop
      // left alone in exponential backoff would not reconnect within the wake.
      const workspace = Workspace.Service.of({
        create: () => Effect.die("unused"),
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
})
