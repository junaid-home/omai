import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import path from "path"
import { Cause, Context, Deferred, Effect, Layer, Schedule } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { vmProjectsRoot } from "./vm-projects"
import { ProvisionState } from "./provision-state"
import type { Target } from "./types"
import { Workspace } from "./workspace"
import { WorkspaceAdapterRuntime } from "./workspace-adapter-runtime"

// Creating a MicroVM project is a durable job on the control plane rather
// than one long HTTP request: each step is persisted on the workspace row
// before the next begins and is safe to re-run, so a crash, restart, closed
// tab or proxy timeout leaves a row that `reconcile` resumes or cleans up.

export type Job = ProvisionState.State & { workspaceID: WorkspaceV2.ID; directory: string }

/** Who asked for the VM; stored on the row and shown in the VM's description. */
export type Owner = { readonly userID: string; readonly username: string; readonly email: string }

type StartInput = { directory: string; mode: ProvisionState.State["mode"]; owner?: Owner }

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Job>
  readonly status: (directory: string) => Effect.Effect<Job | undefined>
  readonly recover: (workspace: Workspace.Info) => Effect.Effect<Job>
  /** Resolves once the job is ready, waiting for its upload, or failed, or once timeoutMs elapses. */
  readonly await: (workspaceID: WorkspaceV2.ID, timeoutMs: number) => Effect.Effect<Job | undefined>
  /** The zip upload into the VM succeeded: finishes a job waiting at step "upload". */
  readonly uploaded: (workspaceID: WorkspaceV2.ID) => Effect.Effect<void>
  readonly reconcile: Effect.Effect<void>
  /**
   * Records a signed-in user's activity (`undefined`: the single local user).
   * A user becoming active gets a reserve VM of their own warmed at once.
   */
  readonly touch: (owner?: Owner) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/control-plane/Provisioner") {}

function env(key: string, fallback: number) {
  const value = Number(process.env[key] ?? fallback)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

const bootDeadlineMs = () => env("OPENCODE_PROVISION_BOOT_DEADLINE_MS", 120_000)
const uploadDeadlineMs = () => env("OPENCODE_PROVISION_UPLOAD_DEADLINE_MS", 1_800_000)
const reconcileMs = () => Math.max(env("OPENCODE_PROVISION_RECONCILE_MS", 15_000), 100)
const failedTtlMs = () => env("OPENCODE_PROVISION_FAILED_TTL_MS", 3_600_000)
// Each active user keeps one reserve VM; it is deleted once its user has made
// no request for this long, and warmed again on their next one.
const reserveIdleMs = () => env("OPENCODE_RESERVE_IDLE_MS", 600_000)
// Caps the booted reserves across all users, so a crowd of visitors cannot
// boot an unbounded number of idle VMs.
const reserveMax = () => env("OPENCODE_RESERVE_MAX", 20)
const HEALTH_POLL_MS = 500
// The Northflank rate limit is shared by the whole team: ask it about the
// VM far less often than we ask the VM itself.
const ADAPTER_POLL_MS = 3_000

// Process-wide so one runner per workspace holds even if the layer is built
// more than once (route groups are provided separately).
const runners = new Map<WorkspaceV2.ID, Deferred.Deferred<void>>()
// Runner slot that serializes reserve refills, so a claim and a reconcile
// never warm two reserves at once.
const RESERVE_REFILL = WorkspaceV2.ID.make("wrk_reserve_refill")
const starting = new Map<string, Deferred.Deferred<Job>>()

// Only the long-lived `serve` process owns background reconciliation. Every
// CLI or TUI process builds the same server routes in-process, and with a
// developer .env that enables the adapter it would otherwise resume, fail and
// clean up the control plane's jobs (and hold short-lived commands open).
const reconciler = { enabled: false }
// Each user's last request, keyed by user ID ("" for the single local user).
// After a restart nobody is known yet, so reserves get one idle window of grace.
const demand = new Map<string, { at: number; owner?: Owner }>()
const bootedAt = Date.now()
// A touch that arrives while a refill pass runs makes it run once more.
const refill = { again: false }
const userOf = (owner?: Owner) => owner?.userID ?? ""
const reserveUser = (row: Workspace.Info) => {
  const userID = (row.extra as { owner?: { userID?: unknown } } | null)?.owner?.userID
  return typeof userID === "string" ? userID : ""
}
const lastSeen = (user: string) => demand.get(user)?.at ?? bootedAt
/** Forgets every user's activity, as after a restart (tests start each case fresh). */
export function resetDemand() {
  demand.clear()
}
/** Records a user's activity; true when they were not active before. */
function seen(owner?: Owner) {
  const user = userOf(owner)
  const previous = demand.get(user)
  const now = Date.now()
  demand.set(user, { at: now, owner: owner ?? previous?.owner })
  return !previous || now - previous.at >= reserveIdleMs()
}
export function enableReconcile() {
  reconciler.enabled = true
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const store = yield* InstanceStore.Service
    const http = yield* HttpClient.HttpClient

    const toJob = (info: Workspace.Info): Job | undefined => {
      if (!info.directory) return undefined
      return { ...(ProvisionState.read(info.extra) ?? legacy(info)), workspaceID: info.id, directory: info.directory }
    }

    const save = Effect.fn("Provisioner.save")(function* (info: Workspace.Info, state: ProvisionState.State) {
      return (yield* workspace.setExtra(info.id, ProvisionState.write(info.extra, state))) ?? info
    })

    // Compare-and-set: a step only commits if the row still holds the state it
    // started from. A step can take minutes, and meanwhile the row may have
    // been removed, marked for deletion, failed by a deadline, or restarted.
    const commit = Effect.fn("Provisioner.commit")(function* (
      info: Workspace.Info,
      from: ProvisionState.State,
      to: ProvisionState.State,
    ) {
      const fresh = yield* workspace.get(info.id)
      if (!fresh) {
        // Removed while the adapter was still creating: whatever it made
        // after the removal has no row left to own it, so delete it now.
        yield* Effect.logWarning("workspace removed during provisioning; deleting late resources", {
          workspaceID: info.id,
        })
        yield* WorkspaceAdapterRuntime.remove(info).pipe(Effect.ignoreCause)
        return false
      }
      const current = ProvisionState.read(fresh.extra)
      if (current?.status !== from.status || current.step !== from.step || current.updatedAt !== from.updatedAt)
        return false
      yield* save(fresh, to)
      return true
    })

    // Runs `effect` detached unless a runner for this workspace is already live.
    const fork = (id: WorkspaceV2.ID, effect: Effect.Effect<void>) =>
      Effect.gen(function* () {
        if (runners.has(id)) return
        const done = Deferred.makeUnsafe<void>()
        runners.set(id, done)
        yield* effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("workspace provision runner failed", { workspaceID: id, error: Cause.pretty(cause) }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              runners.delete(id)
              return Deferred.succeed(done, undefined)
            }),
          ),
          Effect.forkDetach({ startImmediately: true }),
        )
      })

    const settled = (id: WorkspaceV2.ID) => {
      const pending = runners.get(id)
      return pending ? Deferred.await(pending) : Effect.void
    }

    const cleanup = Effect.fn("Provisioner.cleanup")(function* (info: Workspace.Info, state: ProvisionState.State) {
      yield* workspace.stopSync(info.id)
      const removed = yield* WorkspaceAdapterRuntime.remove(info, { keepVolume: state.kind === "recover" }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace provision cleanup failed; will retry", {
            workspaceID: info.id,
            error: message(cause),
          }).pipe(Effect.as(false)),
        ),
      )
      if (!removed) return
      const fresh = yield* workspace.get(info.id)
      const current = fresh && ProvisionState.read(fresh.extra)
      if (fresh && current?.status === "failed") yield* save(fresh, ProvisionState.cleaned(current, Date.now()))
    })

    const fail = Effect.fn("Provisioner.fail")(function* (id: WorkspaceV2.ID, reason: string) {
      const info = yield* workspace.get(id)
      const state = info && ProvisionState.read(info.extra)
      if (!info || !state || state.status !== "running") return
      yield* Effect.logWarning("workspace provision failed", { workspaceID: id, step: state.step, error: reason })
      const failed = ProvisionState.fail(state, reason, Date.now())
      yield* cleanup(yield* save(info, failed), failed)
    })

    const remote = Effect.fn("Provisioner.remote")(function* (info: Workspace.Info) {
      const target = yield* WorkspaceAdapterRuntime.target(info)
      if (target.type !== "remote") return undefined
      return target
    })

    const healthy = (target: Extract<Target, { type: "remote" }>) =>
      http
        .execute(HttpClientRequest.get(route(target.url, "/global/health"), { headers: new Headers(target.headers) }))
        .pipe(
          Effect.map((response) => response.status >= 200 && response.status < 300),
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }),
          Effect.catchCause(() => Effect.succeed(false)),
        )

    // Poll the VM directly instead of letting the sync loop back off
    // exponentially, and ask the adapter whether the container crashed so a
    // crash-looping VM fails in seconds rather than at the deadline.
    const boot = Effect.fn("Provisioner.boot")(function* (info: Workspace.Info, deadline: number) {
      const target = yield* remote(info)
      if (!target) return yield* workspace.startSync(info)
      let asked = 0
      while (true) {
        if (Date.now() >= deadline) return yield* Effect.die(new Error(`Timed out while ${describe("booting")}`))
        if (Date.now() - asked >= ADAPTER_POLL_MS) {
          asked = Date.now()
          const report = yield* WorkspaceAdapterRuntime.health(info).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
          if (report?.state === "failed")
            return yield* Effect.die(new Error(`VM crashed while starting: ${report.reason ?? "unknown reason"}`))
        }
        if (yield* healthy(target)) {
          yield* workspace.startSync(info)
          if (yield* workspace.isSynced(info.id)) return
        }
        yield* Effect.sleep(HEALTH_POLL_MS)
      }
    })

    const setup = Effect.fn("Provisioner.setup")(function* (info: Workspace.Info) {
      const target = yield* remote(info)
      if (!target || !info.directory) return
      const url = route(target.url, "/global/file/create")
      url.searchParams.set("directory", info.directory)
      const directory = info.directory
      // A failed setup deletes the VM, so a passing gateway 5xx or dropped
      // connection is retried (setup is safe to re-run); a rejection is final.
      yield* Effect.gen(function* () {
        const response = yield* http
          .execute(
            HttpClientRequest.post(url, {
              headers: new Headers(target.headers),
              body: HttpBody.jsonUnsafe({ path: directory }),
            }),
          )
          .pipe(
            Effect.timeoutOrElse({
              duration: "60 seconds",
              orElse: () => Effect.fail(new Error(`Timed out while ${describe("setup")}`)),
            }),
          )
        const body = (yield* response.json.pipe(Effect.catchCause(() => Effect.succeed(undefined)))) as
          | { success?: boolean; errors?: { message?: string }[] }
          | undefined
        if (response.status >= 200 && response.status < 300 && body?.success !== false) return
        const error = new Error(body?.errors?.[0]?.message ?? `Project setup failed with HTTP ${response.status}`)
        if (response.status >= 500) return yield* Effect.fail(error)
        return yield* Effect.die(error)
      }).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced("2 seconds") }), Effect.orDie)
    })

    const next = (state: ProvisionState.State): ProvisionState.State["step"] => {
      if (state.step === "creating") return "booting"
      // Recovery boots an existing project from its surviving volume: there is
      // nothing to set up, and re-running it would re-init the repository.
      if (state.step === "booting" && state.kind === "recover") return "done"
      // A reserve is only booted; it becomes a project when claimed.
      if (state.step === "booting" && state.kind === "reserve") return "done"
      if (state.step === "booting") return state.mode === "upload" ? "upload" : "setup"
      return "done"
    }

    const execute = (id: WorkspaceV2.ID): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const info = yield* workspace.get(id)
        const state = info && ProvisionState.read(info.extra)
        if (!info || !state || state.status !== "running") return
        if (state.step === "upload" || state.step === "done") return
        // Creating is never cut short: interrupting it would leave the
        // adapter's in-flight calls creating resources after cleanup ran.
        // The deadline is enforced before and during the later steps.
        if (state.step !== "creating" && Date.now() >= state.deadline)
          return yield* Effect.die(new Error(`Timed out while ${describe(state.step)}`))
        if (state.step === "creating") yield* workspace.provisionVM(info)
        if (state.step === "booting") yield* boot(info, state.deadline)
        if (state.step === "setup") yield* setup(info)
        const advanced = ProvisionState.advance(state, next(state), Date.now(), uploadDeadlineMs())
        if (!(yield* commit(info, state, advanced))) return
        if (advanced.status === "ready")
          yield* Effect.logInfo("workspace provisioned", { workspaceID: id, timings: advanced.timings })
        return yield* execute(id)
      })

    const run = (id: WorkspaceV2.ID) =>
      Effect.gen(function* () {
        const info = yield* workspace.get(id)
        const state = info && ProvisionState.read(info.extra)
        if (!state || state.status !== "running") return
        const exit = yield* execute(id).pipe(Effect.exit)
        if (exit._tag === "Failure") yield* fail(id, message(exit.cause))
      })

    const create = Effect.fn("Provisioner.create")(function* (
      input: StartInput,
      kind: ProvisionState.State["kind"] = "new",
    ) {
      const type = Flag.OPENCODE_WORKSPACE_ADAPTER
      if (!type) return yield* Effect.die(new Error("No workspace adapter is configured"))
      const ctx = yield* store.load({ directory: input.directory })
      const state = ProvisionState.begin({
        kind,
        mode: input.mode,
        now: Date.now(),
        bootDeadlineMs: bootDeadlineMs(),
      })
      // The row exists before any VM does, and carries the job from birth.
      const info = yield* workspace
        .insert({
          type,
          branch: null,
          projectID: ctx.project.id,
          extra: ProvisionState.write(input.owner ? { owner: input.owner } : null, state),
        })
        .pipe(Effect.provideService(InstanceRef, ctx))
      yield* fork(info.id, run(info.id))
      return toJob(info) ?? { ...state, workspaceID: info.id, directory: input.directory }
    })

    const begin = Effect.fn("Provisioner.begin")(function* (input: StartInput) {
      const existing = yield* workspace.getByDirectory(input.directory)
      if (!existing) return (yield* claimReserve(input)) ?? (yield* create(input))
      const state = ProvisionState.read(existing.extra)
      if (!state || state.status === "ready") return toJob(existing)!
      if (state.status === "running") {
        yield* fork(existing.id, run(existing.id))
        return toJob(existing)!
      }
      // Try again: finish cleaning the failed attempt before replacing it, so
      // the new job never races the old one's teardown.
      yield* settled(existing.id)
      // A failed recovery belongs to an existing project: retry it in place.
      // Replacing the row would delete the volume holding the project.
      if (state.kind === "recover") return yield* recover(existing)
      const failed = yield* workspace.get(existing.id)
      const failedState = failed && ProvisionState.read(failed.extra)
      if (failed && failedState && !failedState.cleaned) yield* cleanup(failed, failedState)
      const after = yield* workspace.get(existing.id)
      if (after && !ProvisionState.read(after.extra)?.cleaned) return toJob(after)!
      if (after) yield* workspace.remove(after.id)
      const leftover = yield* workspace.get(existing.id)
      if (leftover) return toJob(leftover)!
      return yield* create(input)
    })

    // Turns the user's reserve into this project. A booted one only needs the
    // project setup, so creation takes seconds; one still booting carries on
    // as the project, so the wait is only what is left of its boot.
    const claimReserve = Effect.fn("Provisioner.claimReserve")(function* (input: StartInput) {
      const rows = (yield* workspace.all()).filter(
        (row) =>
          ProvisionState.read(row.extra)?.kind === "reserve" &&
          reserveUser(row) === userOf(input.owner) &&
          // The reserve's volume is mounted at its parent folder: only a
          // project inside that folder is persisted by it.
          row.directory &&
          input.directory.startsWith(`${path.posix.dirname(row.directory)}/`),
      )
      const reserve =
        rows.find((row) => ProvisionState.read(row.extra)?.status === "ready") ??
        rows.find((row) => ProvisionState.read(row.extra)?.status === "running")
      const current = reserve && ProvisionState.read(reserve.extra)
      if (!reserve?.directory || !current) return undefined
      const ctx = yield* store.load({ directory: input.directory })
      const now = Date.now()
      const booting = current.status === "running"
      const fresh = ProvisionState.begin({ kind: "new", mode: input.mode, now, bootDeadlineMs: bootDeadlineMs() })
      const step = input.mode === "upload" ? "upload" : "setup"
      const state: ProvisionState.State = booting
        ? // A new updatedAt makes the reserve runner's next commit fail, so it
          // can never finish this row as a reserve.
          { ...current, kind: "new", mode: input.mode, updatedAt: Math.max(now, current.updatedAt + 1) }
        : { ...fresh, step, deadline: step === "upload" ? now + uploadDeadlineMs() : fresh.deadline }
      const claimed = yield* workspace.claim(reserve.id, {
        from: reserve.directory,
        directory: input.directory,
        projectID: ctx.project.id,
        extra: ProvisionState.write(input.owner ? { owner: input.owner } : null, state),
      })
      // Someone else took it first; fall back to a fresh VM.
      if (!claimed) return undefined
      yield* Effect.logInfo("claimed reserve VM", { workspaceID: claimed.id, directory: input.directory, booting })
      if (booting) {
        // The reserve runner stops at its next step; resume the job as the
        // project from wherever it got to.
        yield* settled(claimed.id).pipe(Effect.andThen(fork(claimed.id, run(claimed.id))), Effect.forkDetach)
        yield* refillReserves
        return toJob(claimed) ?? { ...state, workspaceID: claimed.id, directory: input.directory }
      }
      // Keep the reserve's sync stream (it is keyed by workspace id only, not
      // the folder). A request that finds the VM unsynced takes the wake path:
      // it resumes and rescales a VM that is already running (which can make
      // Northflank roll it) and holds the request until a new stream connects,
      // so the project opened late and a zip upload landed on a dead stream.
      yield* workspace.startSync(claimed)
      yield* Effect.gen(function* () {
        while (!(yield* workspace.isSynced(claimed.id))) yield* Effect.sleep(HEALTH_POLL_MS)
      }).pipe(Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.void }))
      // A reserve that just became ready may still be unwinding its runner,
      // which would otherwise make the setup fork a no-op.
      yield* settled(claimed.id)
      if (step === "setup") yield* fork(claimed.id, run(claimed.id))
      yield* refillReserves
      return toJob(claimed) ?? { ...state, workspaceID: claimed.id, directory: input.directory }
    })

    // Keeps one reserve per active user (up to OPENCODE_RESERVE_MAX) and
    // removes a reserve once its user has been idle for OPENCODE_RESERVE_IDLE_MS.
    const ensureReserve: Effect.Effect<void> = Effect.gen(function* () {
      if (!Flag.OPENCODE_WORKSPACE_ADAPTER) return
      const now = Date.now()
      const active = (user: string) => now - lastSeen(user) < reserveIdleMs()
      const reserves = (yield* workspace.all()).filter((row) => {
        const state = ProvisionState.read(row.extra)
        return state?.kind === "reserve" && state.status !== "failed"
      })
      yield* Effect.forEach(
        reserves.filter((row) => !runners.has(row.id) && !active(reserveUser(row))),
        (row) =>
          Effect.logInfo("removing idle reserve VM", { workspaceID: row.id, userID: reserveUser(row) }).pipe(
            Effect.andThen(workspace.remove(row.id)),
          ),
        { discard: true },
      )
      const kept = reserves.filter((row) => active(reserveUser(row)))
      const held = new Set(kept.map(reserveUser))
      const missing = [...demand.entries()].filter(([user]) => active(user) && !held.has(user))
      const root = vmProjectsRoot() ?? "/home/runner"
      yield* Effect.forEach(
        missing.slice(0, Math.max(0, reserveMax() - kept.length)),
        ([user, entry]) => {
          // A placeholder directory only the reserve uses; claiming replaces it.
          const directory = `${root}/workspace/.reserve-${crypto.randomUUID().slice(0, 8)}`
          return Effect.logInfo("warming reserve VM", { directory, userID: user }).pipe(
            Effect.andThen(create({ directory, mode: "empty", owner: entry.owner }, "reserve")),
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("reserve VM refill failed", { userID: user, error: message(cause) }),
            ),
          )
        },
        { discard: true },
      )
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("reserve VM refill failed", { error: message(cause) })))

    const refillReserves = Effect.suspend(() => {
      refill.again = true
      return fork(
        RESERVE_REFILL,
        Effect.gen(function* () {
          while (refill.again) {
            refill.again = false
            yield* ensureReserve
          }
        }),
      )
    })

    const touch = Effect.fn("Provisioner.touch")(function* (owner?: Owner) {
      // A MicroVM shares this code but never provisions VMs.
      if (!Flag.OPENCODE_WORKSPACE_ADAPTER || Flag.OPENCODE_WORKSPACE_ID) return
      // Only a user becoming active needs a reserve; later requests just
      // extend their session.
      if (seen(owner)) yield* refillReserves
    })

    // Concurrent starts for one directory share a single attempt.
    const start = Effect.fn("Provisioner.start")(function* (input: StartInput) {
      seen(input.owner)
      const entry = yield* Effect.sync(() => {
        const pending = starting.get(input.directory)
        if (pending) return { deferred: pending, owner: false }
        const deferred = Deferred.makeUnsafe<Job>()
        starting.set(input.directory, deferred)
        return { deferred, owner: true }
      })
      if (!entry.owner) return yield* Deferred.await(entry.deferred)
      yield* entry.deferred.pipe(
        Deferred.complete(begin(input).pipe(Effect.orDie)),
        Effect.ensuring(Effect.sync(() => starting.delete(input.directory))),
      )
      return yield* Deferred.await(entry.deferred)
    })

    const status = Effect.fn("Provisioner.status")(function* (directory: string) {
      const info = yield* workspace.getByDirectory(directory)
      return info ? toJob(info) : undefined
    })

    const recover = Effect.fn("Provisioner.recover")(function* (workspaceInfo: Workspace.Info) {
      const current = (yield* workspace.get(workspaceInfo.id)) ?? workspaceInfo
      if (ProvisionState.read(current.extra)?.status === "running") {
        yield* fork(current.id, run(current.id))
        return toJob(current)!
      }
      // A runner that just finished may still be unwinding; let it go first.
      yield* settled(current.id)
      const info = (yield* workspace.get(current.id)) ?? current
      const state = ProvisionState.begin({
        kind: "recover",
        mode: "empty",
        now: Date.now(),
        bootDeadlineMs: bootDeadlineMs(),
      })
      yield* Effect.logWarning("workspace VM unavailable; re-provisioning", { workspaceID: info.id })
      const saved = yield* save(info, state)
      yield* fork(info.id, run(info.id))
      return toJob(saved)!
    })

    const awaitJob = Effect.fn("Provisioner.await")(function* (id: WorkspaceV2.ID, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const info = yield* workspace.get(id)
        const job = info && toJob(info)
        if (!job) return undefined
        if (job.status !== "running" || ProvisionState.proxyable(job) || Date.now() >= deadline) return job
        yield* Effect.sleep(200)
      }
    })

    const uploaded = Effect.fn("Provisioner.uploaded")(function* (id: WorkspaceV2.ID) {
      const info = yield* workspace.get(id)
      const state = info && ProvisionState.read(info.extra)
      if (!info || !state || state.status !== "running" || state.step !== "upload") return
      const done = ProvisionState.advance(state, "done", Date.now(), uploadDeadlineMs())
      yield* save(info, done)
      yield* Effect.logInfo("workspace provisioned", { workspaceID: id, timings: done.timings })
    })

    const reconcile = Effect.gen(function* () {
      const rows = yield* workspace.all()
      const now = Date.now()
      yield* Effect.forEach(
        rows,
        (info) =>
          Effect.gen(function* () {
            if (!ProvisionState.read(info.extra) || runners.has(info.id)) return
            // The snapshot can be stale by the time this row comes up.
            const fresh = yield* workspace.get(info.id)
            const state = fresh && ProvisionState.read(fresh.extra)
            if (!fresh || !state || runners.has(info.id)) return
            if (state.status === "running" && now >= state.deadline)
              return yield* fork(info.id, fail(info.id, `Timed out while ${describe(state.step)}`))
            if (state.status === "running" && state.step !== "upload") return yield* fork(info.id, run(info.id))
            if (state.status === "failed" && !state.cleaned) return yield* fork(info.id, cleanup(fresh, state))
            if (state.status === "failed" && state.kind !== "recover" && now - state.updatedAt >= failedTtlMs())
              yield* workspace.remove(info.id)
          }),
        { discard: true },
      )
      yield* refillReserves
      yield* settled(RESERVE_REFILL)
    }).pipe(Effect.withSpan("Provisioner.reconcile"))

    // Only a control plane provisions VMs. A VM shares the database (until
    // per-VM schemas land) but carries OPENCODE_WORKSPACE_ID, and must never
    // pick up the control plane's jobs.
    // OPENCODE_PROVISION_RECONCILE is set only on the deployed control plane:
    // a local `serve` pointed at the production database must never run (and
    // race) the deployed control plane's jobs.
    if (
      reconciler.enabled &&
      process.env["OPENCODE_PROVISION_RECONCILE"] === "true" &&
      Flag.OPENCODE_WORKSPACE_ADAPTER &&
      !Flag.OPENCODE_WORKSPACE_ID
    ) {
      yield* reconcile.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace provision reconcile failed", { error: message(cause) }),
        ),
        Effect.repeat(Schedule.spaced(reconcileMs())),
        Effect.forkScoped,
      )
    }

    return Service.of({ start, status, recover, await: awaitJob, uploaded, reconcile, touch })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Workspace.node, InstanceStore.node, httpClient],
})

function legacy(info: Workspace.Info): ProvisionState.State {
  return {
    status: "ready",
    step: "done",
    kind: "new",
    mode: "empty",
    cleaned: false,
    startedAt: info.timeUsed,
    updatedAt: info.timeUsed,
    deadline: info.timeUsed,
    timings: {},
  }
}

function describe(step: ProvisionState.State["step"]) {
  if (step === "creating") return "creating the VM"
  if (step === "booting") return "booting the VM"
  if (step === "setup") return "setting up the project"
  if (step === "upload") return "waiting for the project upload"
  return "finishing"
}

function message(cause: Cause.Cause<unknown>) {
  const die = cause.reasons.find(Cause.isDieReason)
  const fail = cause.reasons.find(Cause.isFailReason)
  const reason: unknown = die?.defect ?? fail?.error
  if (reason instanceof Error) return reason.message
  if (reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string")
    return reason.message
  return Cause.pretty(cause)
}

function route(url: string | URL, path: string) {
  const next = new URL(url)
  next.pathname = `${next.pathname.replace(/\/$/, "")}${path}`
  next.search = ""
  next.hash = ""
  return next
}

export * as Provisioner from "./provisioner"
