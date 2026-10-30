import { afterEach, beforeEach, describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session as SessionNs } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "../../src/auth"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter, WorkspaceHealthReport, WorkspaceInfo } from "../../src/control-plane/types"
import * as Workspace from "../../src/control-plane/workspace"
import { Provisioner } from "../../src/control-plane/provisioner"
import { ProvisionState } from "../../src/control-plane/provision-state"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Provisioner.node,
    Workspace.node,
    Auth.node,
    SessionNs.node,
    SessionProjector.node,
    Database.node,
    InstanceStore.node,
    Ripgrep.node,
  ]),
  [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: true })],
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ],
)
const it = testEffect(layer)

const env = {
  OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
  OPENCODE_PROVISION_BOOT_DEADLINE_MS: "4000",
  OPENCODE_PROVISION_UPLOAD_DEADLINE_MS: "4000",
}
const saved = Object.fromEntries(
  [...Object.keys(env), "OPENCODE_WORKSPACE_ADAPTER"].map((key) => [key, process.env[key]]),
)

beforeEach(() => Object.assign(process.env, env))

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  stops.splice(0).forEach((stop) => stop())
  Provisioner.resetDemand()
  await disposeAllInstances()
  await resetDatabase()
})

const stops: Array<() => void> = []

/** Stand-in for `omai serve` inside the MicroVM: health, sync stream, and folder creation. */
function vmStub() {
  const state = { up: true, created: [] as string[], createFails: undefined as string | undefined, unavailable: 0 }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (!state.up) return new Response(null, { status: 503 })
      if (url.pathname === "/global/health") return Response.json({ healthy: true })
      if (url.pathname === "/global/event")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(":\n\n"))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (url.pathname === "/sync/history") return Response.json([])
      if (url.pathname === "/global/file/create") {
        if (state.unavailable > 0) {
          state.unavailable -= 1
          return new Response("no healthy upstream", { status: 503 })
        }
        if (state.createFails)
          return Response.json({ success: false, errors: [{ message: state.createFails }] }, { status: 400 })
        state.created.push(url.searchParams.get("directory") ?? "")
        return Response.json({ success: true, files: 0 })
      }
      return new Response(null, { status: 404 })
    },
  })
  stops.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, state }
}

type Script = {
  create?: () => Promise<void>
  remove?: (keepVolume: boolean) => Promise<void>
  health?: () => WorkspaceHealthReport
}

function scriptedAdapter(vm: { url: string }, script: Script = {}) {
  const calls = { create: 0, remove: [] as boolean[], extra: [] as unknown[], relabel: [] as (string | null | undefined)[] }
  const adapter: WorkspaceAdapter = {
    name: "scripted",
    description: "scripted test adapter",
    // Pins the instance directory, as the Northflank adapter does for path parity.
    configure: (info: WorkspaceInfo, context) => ({
      ...info,
      directory: info.directory ?? context?.instance?.directory ?? "/unused",
    }),
    async create(info) {
      calls.create += 1
      calls.extra.push(info.extra)
      await script.create?.()
    },
    async remove(_info, context) {
      calls.remove.push(context?.keepVolume === true)
      await script.remove?.(context?.keepVolume === true)
    },
    target: () => ({ type: "remote", url: vm.url }),
    start: async () => {},
    stop: async () => {},
    health: async () => script.health?.() ?? { state: "running" },
    relabel: async (info) => {
      calls.relabel.push(info.directory)
    },
  }
  return { adapter, calls }
}

function setup(script: Script = {}) {
  return Effect.gen(function* () {
    const instance = yield* requireInstance
    const vm = vmStub()
    const type = `scripted-${Math.random().toString(36).slice(2)}`
    const scripted = scriptedAdapter(vm, script)
    registerAdapter(instance.project.id, type, scripted.adapter)
    process.env.OPENCODE_WORKSPACE_ADAPTER = type
    const directory = path.join(instance.directory, "project")
    return { instance, vm, type, directory, calls: scripted.calls }
  })
}

function settle(provisioner: Provisioner.Interface, directory: string, done: (job: Provisioner.Job) => boolean) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const job = yield* provisioner.status(directory)
      if (job && done(job)) return job
      yield* Effect.sleep("50 millis")
    }
    throw new Error(`job for ${directory} did not settle: ${JSON.stringify(yield* provisioner.status(directory))}`)
  })
}

const finished = (job: Provisioner.Job) => job.status !== "running" || job.step === "upload"
const cleanedUp = (job: Provisioner.Job) => job.status === "failed" && job.cleaned

describe("control-plane provisioner", () => {
  it.instance(
    "empty project goes creating → booting → setup → ready and records timings",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        const provisioner = yield* Provisioner.Service

        yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const job = yield* settle(provisioner, ctx.directory, finished)

        expect(job).toMatchObject({ status: "ready", step: "done" })
        expect(Object.keys(job.timings).sort()).toEqual(["booting", "creating", "setup"])
        expect(ctx.vm.state.created).toEqual([ctx.directory])
      }),
    { git: true },
  )

  it.instance(
    "a passing 503 during setup is retried instead of deleting the VM",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        const provisioner = yield* Provisioner.Service
        ctx.vm.state.unavailable = 2

        yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const job = yield* settle(provisioner, ctx.directory, finished)

        expect(job).toMatchObject({ status: "ready", step: "done" })
        expect(ctx.vm.state.created).toEqual([ctx.directory])
        expect(ctx.calls.remove).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "the job records who started it and hands that to the adapter",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        const provisioner = yield* Provisioner.Service
        const workspace = yield* Workspace.Service
        const owner = { userID: "usr_1", username: "alice", email: "alice@example.test" }

        const job = yield* provisioner.start({ directory: ctx.directory, mode: "empty", owner })
        yield* settle(provisioner, ctx.directory, finished)

        expect((yield* workspace.get(job.workspaceID))?.extra).toMatchObject({ owner })
        expect(ctx.calls.extra[0]).toMatchObject({ owner })
      }),
    { git: true },
  )

  it.instance(
    "crash during boot fails fast with the adapter reason and deletes service and volume",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup({ health: () => ({ state: "failed", reason: "OOMKilled" }) })
        ctx.vm.state.up = false
        const provisioner = yield* Provisioner.Service

        const started = Date.now()
        yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const job = yield* settle(provisioner, ctx.directory, cleanedUp)

        expect(job.error).toContain("OOMKilled")
        expect(Date.now() - started).toBeLessThan(3_900)
        expect(ctx.calls.remove).toEqual([false])
      }),
    { git: true },
  )

  it.instance(
    "a job left mid-creating by a restart is resumed by reconcile",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        const workspace = yield* Workspace.Service
        const provisioner = yield* Provisioner.Service
        // What a dead process leaves behind: a row at step creating with no runner.
        yield* workspace.insert({
          type: ctx.type,
          branch: null,
          projectID: ctx.instance.project.id,
          extra: ProvisionState.write(
            null,
            ProvisionState.begin({ kind: "new", mode: "empty", now: Date.now(), bootDeadlineMs: 4_000 }),
          ),
        })
        const row = (yield* workspace.all()).find((item) => item.type === ctx.type)!

        yield* provisioner.reconcile
        const job = yield* settle(provisioner, row.directory!, finished)

        expect(job.status).toBe("ready")
        expect(ctx.calls.create).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "cleanup failure is retried by reconcile",
    () =>
      Effect.gen(function* () {
        const failures = { remaining: 1 }
        const ctx = yield* setup({
          health: () => ({ state: "failed", reason: "boom" }),
          remove: async () => {
            if (failures.remaining-- > 0) throw new Error("northflank unavailable")
          },
        })
        ctx.vm.state.up = false
        const provisioner = yield* Provisioner.Service

        yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const failed = yield* settle(provisioner, ctx.directory, (job) => job.status === "failed")
        yield* Effect.sleep("100 millis")
        expect((yield* provisioner.status(ctx.directory))?.cleaned).toBe(false)
        expect(failed.error).toContain("boom")

        yield* provisioner.reconcile
        yield* settle(provisioner, ctx.directory, cleanedUp)
        expect(ctx.calls.remove).toHaveLength(2)
      }),
    { git: true },
  )

  it.instance(
    "try again waits for the previous cleanup and never runs two jobs",
    () =>
      Effect.gen(function* () {
        const health = { report: { state: "failed", reason: "boom" } as WorkspaceHealthReport }
        const gate = Promise.withResolvers<void>()
        const removing = { blocked: true }
        const ctx = yield* setup({
          health: () => health.report,
          remove: async () => {
            if (removing.blocked) await gate.promise
          },
        })
        ctx.vm.state.up = false
        const provisioner = yield* Provisioner.Service
        const workspace = yield* Workspace.Service

        const first = yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        yield* settle(provisioner, ctx.directory, (job) => job.status === "failed")
        expect(ctx.calls.remove).toHaveLength(1)

        health.report = { state: "running" }
        ctx.vm.state.up = true
        const retry = yield* provisioner.start({ directory: ctx.directory, mode: "empty" }).pipe(Effect.forkChild)
        yield* Effect.sleep("300 millis")
        // Still blocked on the old teardown: no second workspace yet.
        expect((yield* workspace.all()).filter((item) => item.directory === ctx.directory)).toHaveLength(1)

        removing.blocked = false
        gate.resolve()
        const second = yield* Fiber.join(retry)
        const job = yield* settle(provisioner, ctx.directory, finished)

        expect(second.workspaceID).not.toBe(first.workspaceID)
        expect(job).toMatchObject({ status: "ready", workspaceID: second.workspaceID })
        expect((yield* workspace.all()).filter((item) => item.directory === ctx.directory)).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "try again on a failed recovery recovers in place and keeps the volume",
    () =>
      Effect.gen(function* () {
        const health = { report: { state: "running" } as WorkspaceHealthReport }
        const ctx = yield* setup({ health: () => health.report })
        const provisioner = yield* Provisioner.Service
        const workspace = yield* Workspace.Service
        yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const ready = yield* settle(provisioner, ctx.directory, finished)
        health.report = { state: "failed", reason: "boom" }
        ctx.vm.state.up = false
        yield* provisioner.recover((yield* workspace.get(ready.workspaceID))!)
        yield* settle(provisioner, ctx.directory, cleanedUp)

        health.report = { state: "running" }
        ctx.vm.state.up = true
        const retried = yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const job = yield* provisioner.await(retried.workspaceID, 8_000)

        expect(retried.workspaceID).toBe(ready.workspaceID)
        expect(job).toMatchObject({ status: "ready", kind: "recover" })
        expect(ctx.calls.remove).toEqual([true])
      }),
    { git: true },
  )

  it.instance(
    "deleting a workspace while its VM is being created removes what the create made afterwards",
    () =>
      Effect.gen(function* () {
        const gate = Promise.withResolvers<void>()
        const ctx = yield* setup({ create: () => gate.promise })
        const provisioner = yield* Provisioner.Service
        const workspace = yield* Workspace.Service

        const job = yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        yield* Effect.sleep("200 millis")
        expect(ctx.calls.create).toBe(1)
        yield* workspace.remove(job.workspaceID)
        expect(ctx.calls.remove).toHaveLength(1)

        gate.resolve()
        yield* Effect.sleep("500 millis")

        expect(ctx.calls.remove).toHaveLength(2)
        expect(yield* workspace.get(job.workspaceID)).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "a runner never overwrites a row whose state changed under it",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        ctx.vm.state.up = false
        const provisioner = yield* Provisioner.Service
        const workspace = yield* Workspace.Service

        const job = yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        yield* settle(provisioner, ctx.directory, (current) => current.step === "booting")
        const row = (yield* workspace.get(job.workspaceID))!
        const marked = ProvisionState.fail(ProvisionState.read(row.extra)!, "Removal failed", Date.now())
        yield* workspace.setExtra(row.id, ProvisionState.write(row.extra, marked))
        ctx.vm.state.up = true
        yield* Effect.sleep("1500 millis")

        expect((yield* provisioner.status(ctx.directory))?.status).toBe("failed")
      }),
    { git: true },
  )

  it.instance(
    "a create that outlives the boot deadline is cleaned up only after it returns",
    () =>
      Effect.gen(function* () {
        process.env.OPENCODE_PROVISION_BOOT_DEADLINE_MS = "300"
        const order: string[] = []
        const ctx = yield* setup({
          create: async () => {
            await Bun.sleep(800)
            order.push("created")
          },
          remove: async () => {
            order.push("removed")
          },
        })
        const provisioner = yield* Provisioner.Service

        yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const job = yield* settle(provisioner, ctx.directory, cleanedUp)

        expect(job.error).toContain("Timed out")
        expect(order).toEqual(["created", "removed"])
      }),
    { git: true },
  )

  it.instance(
    "recover keeps the volume",
    () =>
      Effect.gen(function* () {
        const health = { report: { state: "running" } as WorkspaceHealthReport }
        const ctx = yield* setup({ health: () => health.report })
        const provisioner = yield* Provisioner.Service
        const workspace = yield* Workspace.Service
        yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const ready = yield* settle(provisioner, ctx.directory, finished)

        health.report = { state: "failed", reason: "boom" }
        ctx.vm.state.up = false
        yield* provisioner.recover((yield* workspace.get(ready.workspaceID))!)
        const job = yield* settle(provisioner, ctx.directory, cleanedUp)

        expect(job).toMatchObject({ kind: "recover", workspaceID: ready.workspaceID })
        expect(ctx.calls.remove).toEqual([true])
      }),
    { git: true },
  )

  it.instance(
    "recover of a healthy VM finishes without re-running project setup",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        const provisioner = yield* Provisioner.Service
        const workspace = yield* Workspace.Service
        yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const ready = yield* settle(provisioner, ctx.directory, finished)
        expect(ctx.vm.state.created).toHaveLength(1)

        yield* provisioner.recover((yield* workspace.get(ready.workspaceID))!)
        const job = yield* provisioner.await(ready.workspaceID, 8_000)

        expect(job).toMatchObject({ status: "ready", kind: "recover" })
        expect(ctx.vm.state.created).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "abandoned upload is cleaned after the upload deadline, not the boot deadline",
    () =>
      Effect.gen(function* () {
        process.env.OPENCODE_PROVISION_BOOT_DEADLINE_MS = "1500"
        process.env.OPENCODE_PROVISION_UPLOAD_DEADLINE_MS = "2500"
        const ctx = yield* setup()
        const provisioner = yield* Provisioner.Service

        yield* provisioner.start({ directory: ctx.directory, mode: "upload" })
        const waiting = yield* settle(provisioner, ctx.directory, finished)
        expect(waiting).toMatchObject({ status: "running", step: "upload" })

        yield* Effect.sleep("1800 millis")
        yield* provisioner.reconcile
        expect((yield* provisioner.status(ctx.directory))?.status).toBe("running")

        yield* Effect.sleep("1000 millis")
        yield* provisioner.reconcile
        yield* settle(provisioner, ctx.directory, cleanedUp)
        expect(ctx.vm.state.created).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "uploaded finishes a job waiting for its zip",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        const provisioner = yield* Provisioner.Service

        const job = yield* provisioner.start({ directory: ctx.directory, mode: "upload" })
        yield* settle(provisioner, ctx.directory, finished)
        yield* provisioner.uploaded(job.workspaceID)

        expect((yield* provisioner.status(ctx.directory))?.status).toBe("ready")
      }),
    { git: true },
  )

  it.instance(
    "concurrent start for one directory creates one workspace",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        const provisioner = yield* Provisioner.Service
        const workspace = yield* Workspace.Service

        const [a, b] = yield* Effect.all(
          [
            provisioner.start({ directory: ctx.directory, mode: "empty" }),
            provisioner.start({ directory: ctx.directory, mode: "empty" }),
          ],
          { concurrency: 2 },
        )

        expect(a.workspaceID).toBe(b.workspaceID)
        yield* settle(provisioner, ctx.directory, finished)
        expect((yield* workspace.all()).filter((item) => item.directory === ctx.directory)).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "await returns as soon as the job is ready",
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        const provisioner = yield* Provisioner.Service

        const job = yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
        const awaited = yield* provisioner.await(job.workspaceID, 8_000)

        expect(awaited?.status).toBe("ready")
      }),
    { git: true },
  )

  describe("reserve VM", () => {
    // The reserve lives under the VM projects root; point it inside the test
    // instance so the scripted adapter (registered per project) serves it.
    const setupReserve = () =>
      Effect.gen(function* () {
        const ctx = yield* setup()
        process.env.OPENCODE_VM_PROJECTS_ROOT = ctx.instance.directory
        return { ...ctx, directory: path.join(ctx.instance.directory, "workspace", "user", "projects", "app") }
      })

    // Most cases follow a single reserve; the per-user count has its own cases.
    beforeEach(() => {
      process.env.OPENCODE_RESERVE_PER_USER = "1"
    })

    afterEach(() => {
      delete process.env.OPENCODE_VM_PROJECTS_ROOT
      delete process.env.OPENCODE_RESERVE_IDLE_MS
      delete process.env.OPENCODE_RESERVE_MAX
      delete process.env.OPENCODE_RESERVE_PER_USER
    })

    const user = (name: string): Provisioner.Owner => ({
      userID: `usr_${name}_${crypto.randomUUID()}`,
      username: name,
      email: `${name}@example.invalid`,
    })
    const ownerOf = (row: Workspace.Info) => (row.extra as { owner?: Provisioner.Owner } | null)?.owner?.userID

    const awaitReserves = (workspace: Workspace.Interface, count: number) =>
      Effect.gen(function* () {
        const deadline = Date.now() + 8_000
        while (Date.now() < deadline) {
          const rows = (yield* workspace.all()).filter((row) => {
            const state = ProvisionState.read(row.extra)
            return state?.kind === "reserve" && state.status === "ready"
          })
          if (rows.length === count) return rows
          yield* Effect.sleep("50 millis")
        }
        throw new Error(`${count} reserves never became ready`)
      })

    const reserveOf = (workspace: Workspace.Interface) =>
      workspace.all().pipe(Effect.map((rows) => rows.find((row) => ProvisionState.read(row.extra)?.kind === "reserve")))

    const awaitReserveReady = (workspace: Workspace.Interface) =>
      Effect.gen(function* () {
        const deadline = Date.now() + 8_000
        while (Date.now() < deadline) {
          const row = yield* reserveOf(workspace)
          if (row && ProvisionState.read(row.extra)?.status === "ready") return row
          yield* Effect.sleep("50 millis")
        }
        throw new Error("reserve never became ready")
      })

    it.instance(
      "keeps one booted reserve while the deployment is in use",
      () =>
        Effect.gen(function* () {
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service

          yield* provisioner.touch()
          yield* provisioner.reconcile
          const reserve = yield* awaitReserveReady(workspace)
          yield* provisioner.reconcile

          expect(ctx.calls.create).toBe(1)
          expect(
            (yield* workspace.all()).filter((row) => ProvisionState.read(row.extra)?.kind === "reserve"),
          ).toHaveLength(1)
          // A reserve is never set up as a project.
          expect(ctx.vm.state.created).toEqual([])
          expect(reserve.directory).not.toBe(ctx.directory)
        }),
      { git: true },
    )

    it.instance(
      "creating a project claims the reserve, skips boot, and warms the next one",
      () =>
        Effect.gen(function* () {
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service
          yield* provisioner.touch()
          yield* provisioner.reconcile
          const reserve = yield* awaitReserveReady(workspace)

          const started = Date.now()
          const job = yield* provisioner.start({ directory: ctx.directory, mode: "empty" })
          const ready = yield* provisioner.await(job.workspaceID, 8_000)

          expect(job.workspaceID).toBe(reserve.id)
          expect(ready).toMatchObject({ status: "ready", kind: "new", directory: ctx.directory })
          expect(Date.now() - started).toBeLessThan(2_000)
          expect(ctx.vm.state.created).toEqual([ctx.directory])
          // The claimed VM was not created again, but now carries the project's label.
          expect(ctx.calls.create).toBe(1)
          expect(ctx.calls.relabel).toContain(ctx.directory)
          // Still synced, so the project's first request proxies straight in
          // instead of "waking" (and so redeploying) a VM that is running.
          expect(yield* workspace.isSynced(reserve.id)).toBe(true)

          yield* provisioner.reconcile
          const next = yield* awaitReserveReady(workspace)
          expect(next.id).not.toBe(reserve.id)
          expect(ctx.calls.create).toBe(2)
        }),
      { git: true },
    )

    it.instance(
      "a zip project claims the reserve straight into its synced upload step",
      () =>
        Effect.gen(function* () {
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service
          yield* provisioner.touch()
          yield* provisioner.reconcile
          const reserve = yield* awaitReserveReady(workspace)

          const job = yield* provisioner.start({ directory: ctx.directory, mode: "upload" })

          expect(job).toMatchObject({ workspaceID: reserve.id, status: "running", step: "upload" })
          expect(yield* workspace.isSynced(reserve.id)).toBe(true)
          yield* provisioner.uploaded(job.workspaceID)
          expect((yield* provisioner.status(ctx.directory))?.status).toBe("ready")
          expect(ctx.vm.state.created).toEqual([])
          // Let the refill finish booting before the instance is torn down.
          expect((yield* awaitReserveReady(workspace)).id).not.toBe(reserve.id)
        }),
      { git: true },
    )

    it.instance(
      "a user becoming active gets their own reserve, and a project claims only its owner's",
      () =>
        Effect.gen(function* () {
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service
          const alice = user("alice")
          const bob = user("bob")

          // No reconcile tick: signing in alone warms the VM.
          yield* provisioner.touch(alice)
          yield* provisioner.touch(bob)
          const reserves = yield* awaitReserves(workspace, 2)
          expect(new Set(reserves.map(ownerOf))).toEqual(new Set([alice.userID, bob.userID]))
          const bobs = reserves.find((row) => ownerOf(row) === bob.userID)!

          const job = yield* provisioner.start({ directory: ctx.directory, mode: "empty", owner: bob })

          expect(job.workspaceID).toBe(bobs.id)
          expect((yield* provisioner.await(job.workspaceID, 8_000))?.status).toBe("ready")
          // Bob is warmed a fresh one; Alice's is still hers.
          const after = yield* awaitReserves(workspace, 2)
          expect(new Set(after.map(ownerOf))).toEqual(new Set([alice.userID, bob.userID]))
          expect(after.map((row) => row.id)).toContain(reserves.find((row) => ownerOf(row) === alice.userID)!.id)
        }),
      { git: true },
    )

    it.instance(
      "a project created while the user's reserve is still booting takes that VM over",
      () =>
        Effect.gen(function* () {
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service
          const alice = user("alice")
          // The VM is not answering yet: the reserve sits in its boot.
          ctx.vm.state.up = false
          yield* provisioner.touch(alice)
          const reserve = yield* Effect.gen(function* () {
            while (true) {
              const row = yield* reserveOf(workspace)
              if (row && ProvisionState.read(row.extra)?.step === "booting") return row
              yield* Effect.sleep("20 millis")
            }
          })

          const job = yield* provisioner.start({ directory: ctx.directory, mode: "empty", owner: alice })

          expect(job).toMatchObject({ workspaceID: reserve.id, kind: "new", status: "running", step: "booting" })
          ctx.vm.state.up = true
          const booted = Date.now()
          const ready = yield* provisioner.await(job.workspaceID, 8_000)
          expect(ready).toMatchObject({ status: "ready", kind: "new", directory: ctx.directory })
          // Only the rest of the one boot, then setup: no second VM, no re-boot.
          expect(Date.now() - booted).toBeLessThan(2_000)
          expect(ctx.vm.state.created).toEqual([ctx.directory])
          const refilled = yield* awaitReserves(workspace, 1)
          expect(refilled[0]?.id).not.toBe(reserve.id)
          expect(ctx.calls.create).toBe(2)
        }),
      { git: true },
    )

    it.instance(
      "a user's reserve is deleted once they go idle while an active user's stays",
      () =>
        Effect.gen(function* () {
          process.env.OPENCODE_RESERVE_IDLE_MS = "1000"
          yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service
          const alice = user("alice")
          const bob = user("bob")
          yield* provisioner.touch(alice)
          yield* provisioner.touch(bob)
          yield* awaitReserves(workspace, 2)

          yield* Effect.sleep("1100 millis")
          // Bob comes back; Alice has left.
          yield* provisioner.touch(bob)
          yield* provisioner.reconcile

          const left = yield* awaitReserves(workspace, 1)
          expect(left.map(ownerOf)).toEqual([bob.userID])
        }),
      { git: true },
    )

    it.instance(
      "a reserve Northflank rejects is not retried every tick",
      () =>
        Effect.gen(function* () {
          // Like a volume below the storage class minimum: every create fails.
          const ctx = yield* setup({ create: () => Promise.reject(new Error("Storage class nvme requires 6144MB")) })
          process.env.OPENCODE_VM_PROJECTS_ROOT = ctx.instance.directory
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service

          yield* provisioner.touch(user("alice"))
          yield* Effect.gen(function* () {
            while (!(yield* workspace.all()).some((row) => ProvisionState.read(row.extra)?.status === "failed"))
              yield* Effect.sleep("20 millis")
          })
          yield* provisioner.reconcile
          yield* provisioner.reconcile

          expect(ctx.calls.create).toBe(1)
        }),
      { git: true },
    )

    it.instance(
      "never boots more reserves than OPENCODE_RESERVE_MAX",
      () =>
        Effect.gen(function* () {
          process.env.OPENCODE_RESERVE_MAX = "1"
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service

          yield* provisioner.touch(user("alice"))
          yield* provisioner.touch(user("bob"))
          yield* awaitReserves(workspace, 1)
          yield* provisioner.reconcile

          expect(ctx.calls.create).toBe(1)
        }),
      { git: true },
    )

    it.instance(
      "each active user keeps two reserves, so a second project also opens at once",
      () =>
        Effect.gen(function* () {
          process.env.OPENCODE_RESERVE_PER_USER = "2"
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service
          const alice = user("alice")

          yield* provisioner.touch(alice)
          const reserves = yield* awaitReserves(workspace, 2)
          expect(reserves.map(ownerOf)).toEqual([alice.userID, alice.userID])

          const first = yield* provisioner.start({ directory: ctx.directory, mode: "empty", owner: alice })
          const second = yield* provisioner.start({
            directory: path.join(path.dirname(ctx.directory), "second"),
            mode: "empty",
            owner: alice,
          })

          // Both projects took a booted reserve instead of creating a VM.
          expect(new Set([first.workspaceID, second.workspaceID])).toEqual(new Set(reserves.map((row) => row.id)))
          // And both are replaced, so the next two projects are instant too.
          const refilled = yield* awaitReserves(workspace, 2)
          expect(refilled.map((row) => row.id).some((id) => reserves.some((row) => row.id === id))).toBe(false)
          expect(ctx.calls.create).toBe(4)
        }),
      { git: true },
    )

    it.instance(
      "under OPENCODE_RESERVE_MAX every active user gets a first reserve before anyone gets a second",
      () =>
        Effect.gen(function* () {
          process.env.OPENCODE_RESERVE_PER_USER = "2"
          process.env.OPENCODE_RESERVE_MAX = "3"
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service
          const alice = user("alice")
          const bob = user("bob")
          const carol = user("carol")

          yield* provisioner.touch(alice)
          yield* awaitReserves(workspace, 2)
          yield* provisioner.touch(bob)
          yield* awaitReserves(workspace, 3)
          yield* provisioner.touch(carol)
          yield* provisioner.reconcile

          // The cap is full, so Carol waits for a slot, and nobody exceeds it.
          const reserves = yield* awaitReserves(workspace, 3)
          expect(reserves.map(ownerOf).filter((owner) => owner === carol.userID)).toHaveLength(0)
          expect(ctx.calls.create).toBe(3)

          // Alice frees a slot by using one; Carol, who has none, gets it
          // ahead of Alice's own refill.
          yield* provisioner.start({ directory: ctx.directory, mode: "empty", owner: alice })
          const after = yield* awaitReserves(workspace, 3)
          expect(after.map(ownerOf).sort()).toEqual([alice.userID, bob.userID, carol.userID].sort())
        }),
      { git: true },
    )

    it.instance(
      "the reserve is deleted once the deployment has been idle",
      () =>
        Effect.gen(function* () {
          process.env.OPENCODE_RESERVE_IDLE_MS = "300"
          const ctx = yield* setupReserve()
          const provisioner = yield* Provisioner.Service
          const workspace = yield* Workspace.Service
          yield* provisioner.touch()
          yield* provisioner.reconcile
          const reserve = yield* awaitReserveReady(workspace)

          yield* Effect.sleep("500 millis")
          yield* provisioner.reconcile

          expect(yield* workspace.get(reserve.id)).toBeUndefined()
          expect(ctx.calls.remove).toEqual([false])
        }),
      { git: true },
    )
  })
})
