import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Context, Effect, FiberMap, Iterable, Layer, Schedule, Schema, Semaphore, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { asc } from "drizzle-orm"
import { and, eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { Project } from "@/project/project"
import { GlobalBus } from "@/bus/global"
import { Auth } from "@/auth"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Slug } from "@opencode-ai/core/util/slug"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { getAdapter, registeredAdapters } from "./adapters"
import { ProvisionState } from "./provision-state"
import { type Target, type WorkspaceInfo, WorkspaceInfo as WorkspaceInfoSchema } from "./types"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { errorData } from "@/util/error"
import { waitEvent } from "./util"
import { WorkspaceRef } from "@/effect/instance-ref"
import { Vcs } from "@/project/vcs"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceAdapterRuntime } from "./workspace-adapter-runtime"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { WorkspaceEvent } from "@opencode-ai/schema/workspace-event"

export const Info = Schema.Struct({
  ...WorkspaceInfoSchema.fields,
  timeUsed: Schema.Number,
}).annotate({ identifier: "Workspace" })
export type Info = WorkspaceInfo & { timeUsed: number }

export const ConnectionStatus = WorkspaceEvent.ConnectionStatus
export type ConnectionStatus = WorkspaceEvent.ConnectionStatus

export const Event = WorkspaceEvent

function fromRow(row: typeof WorkspaceTable.$inferSelect): Info {
  return {
    id: row.id,
    type: row.type,
    branch: row.branch,
    name: row.name,
    directory: row.directory,
    extra: row.extra,
    projectID: row.project_id,
    timeUsed: row.time_used,
  }
}

export const CreateInput = Schema.Struct({
  id: Schema.optional(WorkspaceV2.ID),
  type: Info.fields.type,
  branch: Info.fields.branch,
  projectID: ProjectV2.ID,
  extra: Schema.optional(Info.fields.extra),
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const SessionWarpInput = Schema.Struct({
  workspaceID: Schema.NullOr(WorkspaceV2.ID),
  sessionID: SessionID,
  copyChanges: Schema.optional(Schema.Boolean),
})
export type SessionWarpInput = Schema.Schema.Type<typeof SessionWarpInput>

export class SyncHttpError extends Schema.TaggedErrorClass<SyncHttpError>()("WorkspaceSyncHttpError", {
  message: Schema.String,
  status: Schema.Number,
  body: Schema.optional(Schema.String),
}) {}

export class WorkspaceNotFoundError extends Schema.TaggedErrorClass<WorkspaceNotFoundError>()(
  "WorkspaceNotFoundError",
  {
    message: Schema.String,
    workspaceID: WorkspaceV2.ID,
  },
) {}

export class SessionEventsNotFoundError extends Schema.TaggedErrorClass<SessionEventsNotFoundError>()(
  "WorkspaceSessionEventsNotFoundError",
  {
    message: Schema.String,
    sessionID: SessionID,
  },
) {}

export class SessionWarpHttpError extends Schema.TaggedErrorClass<SessionWarpHttpError>()(
  "WorkspaceSessionWarpHttpError",
  {
    message: Schema.String,
    workspaceID: WorkspaceV2.ID,
    sessionID: SessionID,
    status: Schema.Number,
    body: Schema.String,
  },
) {}

export class SyncTimeoutError extends Schema.TaggedErrorClass<SyncTimeoutError>()("WorkspaceSyncTimeoutError", {
  message: Schema.String,
  state: Schema.Record(Schema.String, Schema.Number),
}) {}

export class SyncAbortedError extends Schema.TaggedErrorClass<SyncAbortedError>()("WorkspaceSyncAbortedError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type CreateError = Auth.AuthError
type SessionWarpError =
  | WorkspaceNotFoundError
  | SessionEventsNotFoundError
  | SessionWarpHttpError
  | Vcs.PatchApplyError
  | HttpClientError.HttpClientError
type WaitForSyncError = SyncTimeoutError | SyncAbortedError
type SyncLoopError = SyncHttpError | HttpClientError.HttpClientError

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, CreateError>
  /** Configure and persist the row only; no VM is created. */
  readonly insert: (input: CreateInput) => Effect.Effect<Info>
  /** Create (or idempotently re-create) the workspace's VM through its adapter. */
  readonly provisionVM: (info: Info) => Effect.Effect<void, CreateError>
  readonly setExtra: (id: WorkspaceV2.ID, extra: unknown) => Effect.Effect<Info | undefined>
  /**
   * Atomically re-points a row at a new directory, only if it still has
   * `from`: two creations racing for one reserve VM cannot both win.
   */
  readonly claim: (
    id: WorkspaceV2.ID,
    input: { from: string; directory: string; projectID: ProjectV2.ID; extra: unknown },
  ) => Effect.Effect<Info | undefined>
  readonly sessionWarp: (input: SessionWarpInput) => Effect.Effect<void, SessionWarpError>
  readonly list: (project: Project.Info) => Effect.Effect<Info[]>
  readonly syncList: (project: Project.Info) => Effect.Effect<void>
  readonly get: (id: WorkspaceV2.ID) => Effect.Effect<Info | undefined>
  readonly getByDirectory: (directory: string) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
  readonly remove: (id: WorkspaceV2.ID) => Effect.Effect<Info | undefined>
  readonly status: () => Effect.Effect<ConnectionStatus[]>
  readonly isSyncing: (workspaceID: WorkspaceV2.ID) => Effect.Effect<boolean>
  /** True only once the sync stream is actually connected to the remote target. */
  readonly isSynced: (workspaceID: WorkspaceV2.ID) => Effect.Effect<boolean>
  readonly waitForSync: (
    workspaceID: WorkspaceV2.ID,
    state: Record<string, number>,
    signal?: AbortSignal,
    timeout?: number,
  ) => Effect.Effect<void, WaitForSyncError>
  readonly startWorkspaceSyncing: (projectID: ProjectV2.ID) => Effect.Effect<void>
  readonly startSync: (workspace: Info) => Effect.Effect<void>
  readonly stopSync: (workspaceID: WorkspaceV2.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Workspace") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const session = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2Bridge.Service
    const vcs = yield* Vcs.Service
    const flags = yield* RuntimeFlags.Service
    const fs = yield* FSUtil.Service
    const { db } = yield* Database.Service
    const connections = new Map<WorkspaceV2.ID, ConnectionStatus>()
    // VMs whose event stream is open. Requests are served by the VM itself, so
    // this — not the (possibly minute-long) local history replay that follows
    // — is what makes a workspace ready to proxy.
    const reachable = new Set<WorkspaceV2.ID>()
    const syncFibers = yield* FiberMap.make<WorkspaceV2.ID, void, SyncLoopError>()

    const setStatus = (id: WorkspaceV2.ID, status: ConnectionStatus["status"]) => {
      const prev = connections.get(id)
      if (prev?.status === status) return
      const next = { workspaceID: id, status }
      connections.set(id, next)

      GlobalBus.emit("event", {
        directory: "global",
        workspace: id,
        payload: {
          type: Event.Status.type,
          properties: next,
        },
      })
    }

    const connectSSE = Effect.fn("Workspace.connectSSE")(function* (
      url: URL | string,
      headers: HeadersInit | undefined,
    ) {
      // A booting or resuming VM sits behind Northflank's ingress, which can
      // hold a request open without answering for 30-60s. Without a bound the
      // workspace stays "connecting" that long and the fast wake/boot retries
      // (which only restart a failed loop) never get a turn.
      const response = yield* http
        .execute(
          HttpClientRequest.get(route(url, "/global/event"), {
            headers: new Headers(headers),
            accept: "text/event-stream",
          }),
        )
        .pipe(
          Effect.timeoutOrElse({
            duration: connectTimeoutMs(),
            orElse: () => Effect.fail(new SyncHttpError({ message: "Workspace sync connect timed out", status: 504 })),
          }),
        )
      if (response.status < 200 || response.status >= 300) {
        return yield* new SyncHttpError({
          message: `Workspace sync HTTP failure: ${response.status}`,
          status: response.status,
        })
      }
      // The VM heartbeats every 10s; a stream silent for longer froze or lost
      // its VM without the connection closing, so end it and reconnect
      // rather than keep reporting a dead workspace as connected.
      return response.stream.pipe(Stream.timeout(streamIdleMs()))
    })

    const parseSSE = Effect.fn("Workspace.parseSSE")(function* (
      stream: Stream.Stream<Uint8Array, unknown>,
      onEvent: (event: unknown) => Effect.Effect<void>,
    ) {
      yield* stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapAccum(
          () => ({ data: [] as string[], id: undefined as string | undefined, retry: 1000 }),
          (state, line) => {
            if (line === "") {
              if (!state.data.length) return [state, []]
              return [{ ...state, data: [] }, [{ data: state.data.join("\n"), id: state.id, retry: state.retry }]]
            }

            const index = line.indexOf(":")
            const field = index === -1 ? line : line.slice(0, index)
            const value = index === -1 ? "" : line.slice(index + (line[index + 1] === " " ? 2 : 1))

            if (field === "data") return [{ ...state, data: [...state.data, value] }, []]
            if (field === "id") return [{ ...state, id: value }, []]
            if (field === "retry") {
              const retry = Number.parseInt(value, 10)
              return [Number.isNaN(retry) ? state : { ...state, retry }, []]
            }
            return [state, []]
          },
          {
            onHalt: (state) =>
              state.data.length ? [{ data: state.data.join("\n"), id: state.id, retry: state.retry }] : [],
          },
        ),
        Stream.map((event) => {
          try {
            return JSON.parse(event.data) as unknown
          } catch {
            return {
              type: "sse.message",
              properties: {
                data: event.data,
                id: event.id || undefined,
                retry: event.retry,
              },
            }
          }
        }),
        Stream.runForEach(onEvent),
      )
    })

    const runInWorkspace = <A, E, R>(input: {
      workspaceID?: WorkspaceV2.ID
      local: () => Effect.Effect<A, E, R>
      remote: (input: {
        workspace: Info
        target: Extract<Target, { type: "remote" }>
      }) => HttpClientRequest.HttpClientRequest
      fallback: A
      response?: "json" | "text"
    }) =>
      Effect.gen(function* () {
        if (!input.workspaceID) return yield* input.local()

        const workspace = yield* get(input.workspaceID)
        if (!workspace) return input.fallback

        const target = yield* WorkspaceAdapterRuntime.target(workspace)

        if (target.type === "local") {
          const store = yield* InstanceStore.Service
          return yield* store.provide({ directory: target.directory }, input.local())
        }

        const response = yield* http.execute(input.remote({ workspace, target })).pipe(
          Effect.catch((error) =>
            Effect.logWarning("workspace target request failed", {
              workspaceID: workspace.id,
              error: errorData(error),
            }).pipe(Effect.as(undefined)),
          ),
        )
        if (!response) return input.fallback
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
          yield* Effect.logWarning("workspace target request failed", {
            workspaceID: workspace.id,
            status: response.status,
            body,
          })
          return input.fallback
        }

        const body = input.response === "text" ? response.text : response.json
        return yield* body.pipe(
          Effect.map((result) => result as A),
          Effect.catch((error) =>
            Effect.logWarning("workspace target response decode failed", {
              workspaceID: workspace.id,
              error: errorData(error),
            }).pipe(Effect.as(input.fallback)),
          ),
        )
      })

    const syncHistory = Effect.fn("Workspace.syncHistory")(function* (
      space: Info,
      url: URL | string,
      headers: HeadersInit | undefined,
    ) {
      const sessionIDs = (yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.workspace_id, space.id))
        .pipe(Effect.orDie)).map((row) => row.id)
      const state = sessionIDs.length
        ? Object.fromEntries(
            (yield* db
              .select()
              .from(EventSequenceTable)
              .where(inArray(EventSequenceTable.aggregate_id, sessionIDs))
              .pipe(Effect.orDie)).map((row) => [row.aggregate_id, row.seq]),
          )
        : {}

      const response = yield* http
        .execute(
          HttpClientRequest.post(route(url, "/sync/history"), {
            headers: new Headers(headers),
            body: HttpBody.jsonUnsafe(state),
          }),
        )
        .pipe(
          Effect.timeoutOrElse({
            duration: historyTimeoutMs(),
            orElse: () =>
              Effect.fail(new SyncHttpError({ message: "Workspace history request timed out", status: 504 })),
          }),
        )

      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text
        return yield* new SyncHttpError({
          message: `Workspace history HTTP failure: ${response.status} ${body}`,
          status: response.status,
          body,
        })
      }

      const history = (yield* response.json) as HistoryEvent[]

      yield* Effect.forEach(
        history,
        (event) =>
          events
            .replay(
              {
                id: EventV2.ID.make(event.id),
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: event.data,
              },
              { publish: true, ownerID: space.id },
            )
            .pipe(Effect.provideService(WorkspaceRef, space.id)),
        { discard: true },
      )
    })

    const syncWorkspaceLoop = Effect.fn("Workspace.syncWorkspaceLoop")(function* (space: Info) {
      let target: Target | null = null
      for (let i = 0; i < 60; i++) {
        target = yield* WorkspaceAdapterRuntime.target(space).pipe(Effect.catch((error) => Effect.succeed(null)))
        if (target) break
        yield* Effect.sleep("2 seconds")
      }
      if (!target) {
        setStatus(space.id, "error")
        return
      }
      // Local targets resolve their status inline: this loop returns for them
      // below without ever connecting, and create() waits on connected|error.
      if (target.type === "local") {
        setStatus(space.id, (yield* fs.existsSafe(target.directory)) ? "connected" : "error")
        return
      }

      let attempt = 0

      while (true) {
        setStatus(space.id, "connecting")

        const stream = yield* connectSSE(target.url, target.headers).pipe(
          Effect.tap(() => Effect.sync(() => reachable.add(space.id))),
          Effect.catch((err) =>
            Effect.gen(function* () {
              reachable.delete(space.id)
              setStatus(space.id, "error")
              yield* Effect.logWarning("failed to connect to global sync", {
                workspace: space.name,
                error: errorData(err),
              })
              return null
            }),
          ),
        )

        if (stream) {
          attempt = 0

          // The live stream is read from the start: the VM is already serving
          // requests, so the first prompt's events must neither wait behind a
          // slow history catch-up nor be dropped when it times out. Only
          // durable sync events wait, since they replay in strict sequence
          // after the history.
          const caughtUp = { done: false }
          const pending: unknown[] = []
          const lock = Semaphore.makeUnsafe(1)
          const handle = (evt: unknown) =>
            Effect.gen(function* () {
              if (!evt || typeof evt !== "object" || !("payload" in evt)) return
              const payload = evt.payload as { type?: string; syncEvent?: EventV2.SerializedEvent }
              if (payload.type === "server.heartbeat") return

              if (payload.type === "sync" && payload.syncEvent) {
                const sync = payload.syncEvent
                // A MicroVM shares this database, so its events arrive already
                // committed. Replaying one would only lock the session row the
                // VM is writing and re-encode a payload of up to megabytes to
                // find it unchanged; the first replay still claims the owner.
                const stored = yield* db
                  .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, sync.aggregateID))
                  .pipe(Database.first, Effect.orDie)
                const failed =
                  stored?.ownerID === space.id && stored.seq >= sync.seq
                    ? false
                    : yield* events.replay(sync, { publish: true, ownerID: space.id }).pipe(
                        Effect.as(false),
                        Effect.catchCause((error) =>
                          Effect.logWarning("failed to replay global event", error).pipe(
                            Effect.annotateLogs({ workspaceID: space.id }),
                            Effect.as(true),
                          ),
                        ),
                      )
                if (failed) return
              }

              try {
                const event = evt as { directory?: string; project?: string; payload: unknown }
                GlobalBus.emit("event", {
                  directory: event.directory,
                  project: event.project,
                  workspace: space.id,
                  payload: event.payload,
                })
              } catch (error) {
                yield* Effect.logWarning("failed to emit global event", {
                  workspaceID: space.id,
                  error: errorData(error),
                })
              }
            })
          const catchUp = syncHistory(space, target.url, target.headers).pipe(
            Effect.retry({ times: 2, schedule: Schedule.spaced("2 seconds") }),
            Effect.catch((err) =>
              Effect.logWarning("workspace history catch-up failed; continuing with the live stream", {
                workspace: space.name,
                error: errorData(err),
              }),
            ),
            Effect.andThen(
              lock.withPermit(
                Effect.suspend(() => {
                  caughtUp.done = true
                  return Effect.forEach(pending.splice(0), handle, { discard: true })
                }),
              ),
            ),
            // "connected" still means caught up: callers such as create()
            // wait for it before using the workspace's local history.
            Effect.andThen(Effect.sync(() => setStatus(space.id, "connected"))),
          )
          const live = parseSSE(stream, (evt) => {
            if (caughtUp.done || (evt as { payload?: { type?: string } } | null)?.payload?.type !== "sync")
              return handle(evt)
            return lock.withPermit(
              Effect.suspend(() => {
                if (caughtUp.done) return handle(evt)
                pending.push(evt)
                return Effect.void
              }),
            )
          }).pipe(
            // A suspended (or crashed) MicroVM drops the stream abruptly; treat
            // an interrupted stream as a disconnect so this loop survives and
            // retries, reconnecting once the VM resumes, instead of dying and
            // leaving the workspace unsyncable until a full restart.
            Effect.catchCause((cause) =>
              Effect.logWarning("workspace sync stream interrupted", {
                workspaceID: space.id,
                error: errorData(cause),
              }),
            ),
          )
          // The catch-up is time-bounded, so a stream that ends first simply
          // waits for it before reconnecting.
          yield* Effect.all([live, catchUp], { concurrency: 2, discard: true })

          reachable.delete(space.id)
          setStatus(space.id, "disconnected")
        }

        // Back off reconnect attempts up to 2 minutes while the workspace
        // stays unavailable.
        yield* Effect.sleep(`${Math.min(120_000, 1_000 * 2 ** attempt)} millis`)
        attempt += 1
      }
    })

    const startSync = Effect.fn("Workspace.startSync")(function* (space: Info) {
      if (!flags.experimentalWorkspaces && !Flag.OPENCODE_WORKSPACE_ADAPTER) return

      const exists = yield* FiberMap.has(syncFibers, space.id)
      if (exists && connections.get(space.id)?.status !== "error") return

      // Local targets resolve their status inline: the sync loop returns for
      // them without ever connecting, and create() waits on connected|error
      // before handing the workspace back.
      const target = yield* WorkspaceAdapterRuntime.target(space).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("workspace target failed", {
              workspaceID: space.id,
              error: errorData(error),
            })
            return null
          }),
        ),
      )
      if (target?.type === "local") {
        setStatus(space.id, (yield* fs.existsSafe(target.directory)) ? "connected" : "error")
        return
      }
      // An unresolved target still runs the loop (which retries resolution),
      // but reports the failure now so create() does not block on its budget.
      setStatus(space.id, target ? "disconnected" : "error")

      yield* FiberMap.run(
        syncFibers,
        space.id,
        // TODO: look into `tapError` to set the status but still
        // allow the fiber to fail and automatically get removed
        syncWorkspaceLoop(space).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              setStatus(space.id, "error")
              yield* Effect.logWarning("workspace listener failed", {
                workspaceID: space.id,
                error: errorData(error),
              })
            }),
          ),
        ),
      )
    })

    const stopSync = Effect.fn("Workspace.stopSync")(function* (id: WorkspaceV2.ID) {
      yield* FiberMap.remove(syncFibers, id)
      reachable.delete(id)
      connections.delete(id)
    })

    const insert = Effect.fn("Workspace.insert")(function* (input: CreateInput) {
      const id = WorkspaceV2.ID.ascending(input.id)
      const adapter = getAdapter(input.projectID, input.type)
      const config = yield* WorkspaceAdapterRuntime.configure(adapter, {
        ...input,
        id,
        name: Slug.create(),
        directory: null,
        extra: input.extra ?? null,
      })

      const info: Info = {
        id,
        type: config.type,
        branch: config.branch ?? null,
        name: config.name ?? null,
        directory: config.directory ?? null,
        extra: config.extra ?? null,
        projectID: input.projectID,
        timeUsed: Date.now(),
      }

      yield* db
        .insert(WorkspaceTable)
        .values({
          id: info.id,
          type: info.type,
          branch: info.branch,
          name: info.name,
          directory: info.directory,
          extra: info.extra,
          project_id: info.projectID,
          time_used: info.timeUsed,
        })
        .pipe(Effect.orDie)

      return info
    })

    const provisionVM = Effect.fn("Workspace.provisionVM")(function* (info: Info) {
      const adapter = getAdapter(info.projectID, info.type)
      const env = {
        OPENCODE_AUTH_CONTENT: JSON.stringify(yield* auth.all()),
        OPENCODE_WORKSPACE_ID: info.id,
        OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
        OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
        // The VM's serve needs its database identity: whoever provisions the
        // per-VM schema + restricted role sets these before create and they
        // ride to the instance. Migrator credentials never leave the control
        // plane. (Per-VM provisioning wiring is Phase F; until then a shared
        // control-plane role is forwarded as-is.)
        // The control plane may reach the database another way than its VMs:
        // a laptop uses the public address while VMs sit on the private
        // network. OPENCODE_VM_DATABASE_URL names the VMs' address.
        OPENCODE_DATABASE_URL: process.env.OPENCODE_VM_DATABASE_URL ?? process.env.OPENCODE_DATABASE_URL,
        // One project per VM needs few connections; 100 VMs at the default of
        // 10 would exceed the database's connection budget.
        OPENCODE_DATABASE_POOL_SIZE: process.env.OPENCODE_VM_DATABASE_POOL_SIZE ?? "3",
        OPENCODE_DATABASE_SCHEMA: process.env.OPENCODE_DATABASE_SCHEMA,
        OPENCODE_INSTANCE_ID: process.env.OPENCODE_INSTANCE_ID,
        OPENCODE_DATA_KEY: process.env.OPENCODE_DATA_KEY,
        // The VM boots the same central transport as the control plane
        // (central() is true as soon as the database URL is set), and the
        // proxy forwards the browser's Origin and session cookie verbatim.
        // So the VM must share the deployment origin for sameOrigin() checks
        // and hold the signing key to verify the forwarded token. Previews are
        // excluded on purpose: OPENCODE_PREVIEW_URL routes to the control
        // plane's preview listener, and a workspace has no public hostname of
        // its own to expose one on.
        OPENCODE_PUBLIC_URL: process.env.OPENCODE_PUBLIC_URL,
        OPENCODE_JWT_SECRET: process.env.OPENCODE_JWT_SECRET,
        OPENCODE_SERVER_PORT: process.env.OPENCODE_SERVER_PORT ?? "4096",
        OPENCODE_FRONTEND_PORT: process.env.OPENCODE_FRONTEND_PORT ?? "80",
        OPENCODE_SERVER_PROTOCOL: process.env.OPENCODE_SERVER_PROTOCOL ?? "http",
        OPENCODE_HOST: process.env.OPENCODE_HOST ?? "0.0.0.0",
        // Publish runs inside the VM, so it needs the deployment's Cloudflare
        // account. Build commands never see these: publish strips them first.
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_PLATFORM_ZONE: process.env.CLOUDFLARE_PLATFORM_ZONE,
        CLOUDFLARE_DISPATCH_NAMESPACE: process.env.CLOUDFLARE_DISPATCH_NAMESPACE,
      }

      // Adapters receive the persisted fields only, never control-plane bookkeeping.
      const target = {
        id: info.id,
        type: info.type,
        name: info.name,
        branch: info.branch,
        directory: info.directory,
        extra: info.extra,
        projectID: info.projectID,
      }
      yield* WorkspaceAdapterRuntime.create(adapter, target, env)
    })

    const setExtra = Effect.fn("Workspace.setExtra")(function* (id: WorkspaceV2.ID, extra: unknown) {
      yield* db.update(WorkspaceTable).set({ extra }).where(eq(WorkspaceTable.id, id)).pipe(Effect.orDie)
      return yield* get(id)
    })

    const claim = Effect.fn("Workspace.claim")(function* (
      id: WorkspaceV2.ID,
      input: { from: string; directory: string; projectID: ProjectV2.ID; extra: unknown },
    ) {
      const rows = yield* db
        .update(WorkspaceTable)
        .set({ directory: input.directory, project_id: input.projectID, extra: input.extra, time_used: Date.now() })
        .where(and(eq(WorkspaceTable.id, id), eq(WorkspaceTable.directory, input.from)))
        .returning()
        .pipe(Effect.orDie)
      return rows[0] ? fromRow(rows[0]) : undefined
    })

    const create = Effect.fn("Workspace.create")(function* (input: CreateInput) {
      const info = yield* insert(input)
      yield* provisionVM(info)
      // The sync loop must outlive the create fence: a cold MicroVM can boot
      // slower than the fence waits, and `Effect.all` would interrupt
      // `startSync` before it forks the loop fiber — stranding the workspace
      // with no sync fiber at all, so every later request fails with
      // "broken sync connection" forever. Fork it detached; the loop retries
      // with backoff until the VM answers.
      yield* startSync(info).pipe(Effect.forkDetach({ startImmediately: true }))
      yield* waitEvent({
        timeout: createTimeout(),
        fn(event) {
          if (event.workspace === info.id && event.payload.type === Event.Status.type) {
            const { status } = event.payload.properties
            return status === "error" || status === "connected"
          }
          return false
        },
      })

      return info
    })

    const sessionWarp = Effect.fn("Workspace.sessionWarp")(function* (input: SessionWarpInput) {
      return yield* Effect.gen(function* () {
        const current = yield* db
          .select({ workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .pipe(Database.first)
          .pipe(Effect.orDie)

        if (current?.workspaceID) {
          const previous = yield* get(current.workspaceID)
          if (previous) {
            const target = yield* WorkspaceAdapterRuntime.target(previous)

            if (target.type === "remote") {
              yield* syncHistory(previous, target.url, target.headers).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("session warp final source sync failed", {
                    workspaceID: previous.id,
                    sessionID: input.sessionID,
                    error: errorData(error),
                  }),
                ),
              )
            } else {
              yield* prompt.cancel(input.sessionID)
            }

            // "claim" this session so any future events coming from
            // the old workspace are ignored
            yield* events.claim(input.sessionID, input.workspaceID ?? previous.projectID)
          }
        }

        const sourcePatch =
          input.copyChanges && current?.workspaceID
            ? yield* runInWorkspace({
                workspaceID: current?.workspaceID ?? undefined,
                local: () => vcs.diffRaw(),
                remote: ({ target }) =>
                  HttpClientRequest.get(route(target.url, "/vcs/diff/raw"), {
                    headers: new Headers(target.headers),
                  }),
                fallback: "",
                response: "text",
              }).pipe(Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)))
            : ""

        if (sourcePatch) {
          // Attempt to apply the file changes to the new workspace.
          // We intentionally do first so if it fails we don't warp
          // the session.
          yield* runInWorkspace({
            workspaceID: input.workspaceID ?? undefined,
            local: () => vcs.apply({ patch: sourcePatch }),
            remote: ({ target }) =>
              HttpClientRequest.post(route(target.url, "/vcs/apply"), {
                headers: new Headers(target.headers),
                body: HttpBody.jsonUnsafe({ patch: sourcePatch }),
              }),
            fallback: { applied: false },
          }).pipe(Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)))
        }

        if (input.workspaceID === null) {
          yield* session.setWorkspace({ sessionID: input.sessionID, workspaceID: undefined })

          return
        }

        const workspaceID = input.workspaceID
        const space = yield* get(workspaceID)
        if (!space)
          return yield* new WorkspaceNotFoundError({
            message: `Workspace not found: ${workspaceID}`,
            workspaceID,
          })

        const target = yield* WorkspaceAdapterRuntime.target(space)

        if (target.type === "local") {
          yield* session.setWorkspace({ sessionID: input.sessionID, workspaceID: input.workspaceID })

          return
        }

        const rows = yield* db
          .select({
            id: EventTable.id,
            aggregateID: EventTable.aggregate_id,
            seq: EventTable.seq,
            type: EventTable.type,
            data: EventTable.data,
          })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, input.sessionID))
          .orderBy(asc(EventTable.seq))
          .pipe(Effect.orDie)
        if (rows.length === 0)
          return yield* new SessionEventsNotFoundError({
            message: `No events found for session: ${input.sessionID}`,
            sessionID: input.sessionID,
          })

        const batches = Iterable.chunksOf(rows, 10)
        const total = Iterable.size(batches)

        yield* Effect.forEach(
          batches,
          (events, i) =>
            Effect.gen(function* () {
              const response = yield* http.execute(
                HttpClientRequest.post(route(target.url, "/sync/replay"), {
                  headers: new Headers(target.headers),
                  body: HttpBody.jsonUnsafe({
                    directory: space.directory ?? "",
                    events,
                  }),
                }),
              )

              if (response.status < 200 || response.status >= 300) {
                const body = yield* response.text
                return yield* new SessionWarpHttpError({
                  message: `Failed to warp session ${input.sessionID} into workspace ${workspaceID}: HTTP ${response.status} ${body}`,
                  workspaceID,
                  sessionID: input.sessionID,
                  status: response.status,
                  body,
                })
              }
            }),
          { discard: true },
        )

        const response = yield* http.execute(
          HttpClientRequest.post(route(target.url, "/sync/steal"), {
            headers: new Headers(target.headers),
            body: HttpBody.jsonUnsafe({ sessionID: input.sessionID }),
          }),
        )
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text
          return yield* new SessionWarpHttpError({
            message: `Failed to steal session ${input.sessionID} into workspace ${workspaceID}: HTTP ${response.status} ${body}`,
            workspaceID,
            sessionID: input.sessionID,
            status: response.status,
            body,
          })
        }

        yield* session.setWorkspace({ sessionID: input.sessionID, workspaceID: input.workspaceID })
      })
    })

    const list = Effect.fn("Workspace.list")(function* (project: Project.Info) {
      return (yield* db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, project.id))
        .pipe(Effect.orDie))
        .map(fromRow)
        .sort((a, b) => a.id.localeCompare(b.id))
    })

    const syncList = Effect.fn("Workspace.syncList")(function* (project: Project.Info) {
      const names = new Set((yield* list(project)).map((workspace) => workspace.name))
      const discovered = yield* Effect.forEach(
        registeredAdapters(project.id),
        ([type, adapter]) =>
          WorkspaceAdapterRuntime.list(adapter).pipe(
            Effect.catchCause((error) =>
              Effect.logWarning("workspace adapter list failed", { type, error }).pipe(Effect.as([])),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items) => items.flat()))

      yield* Effect.forEach(
        discovered,
        (item) =>
          Effect.gen(function* () {
            if (names.has(item.name)) return
            names.add(item.name)

            const info: Info = {
              id: WorkspaceV2.ID.ascending(),
              type: item.type,
              branch: item.branch,
              name: item.name,
              directory: item.directory,
              extra: item.extra,
              projectID: item.projectID,
              timeUsed: Date.now(),
            }

            yield* db
              .insert(WorkspaceTable)
              .values({
                id: info.id,
                type: info.type,
                branch: info.branch,
                name: info.name,
                directory: info.directory,
                extra: info.extra,
                project_id: info.projectID,
                time_used: info.timeUsed,
              })
              .pipe(Effect.orDie)

            yield* startSync(info)
          }),
        { concurrency: 1 },
      )
    })

    const get = Effect.fn("Workspace.get")(function* (id: WorkspaceV2.ID) {
      const row = yield* db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.id, id))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!row) return
      return fromRow(row)
    })

    const getByDirectory = Effect.fn("Workspace.getByDirectory")(function* (directory: string) {
      const row = yield* db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.directory, directory))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!row) return
      return fromRow(row)
    })

    const all = Effect.fn("Workspace.all")(function* () {
      return (yield* db.select().from(WorkspaceTable).pipe(Effect.orDie)).map(fromRow)
    })

    const remove = Effect.fn("Workspace.remove")(function* (id: WorkspaceV2.ID) {
      const sessions = yield* db
        .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.workspace_id, id))
        .pipe(Effect.orDie)
      const sessionIDs = new Set(sessions.map((sessionInfo) => sessionInfo.id))
      yield* Effect.forEach(
        sessions.filter((sessionInfo) => !sessionInfo.parentID || !sessionIDs.has(sessionInfo.parentID)),
        (sessionInfo) =>
          session.remove(sessionInfo.id).pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.void)),
        { discard: true },
      )

      const row = yield* db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.id, id))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!row) return

      yield* stopSync(id)

      const info = fromRow(row)
      // A row whose adapter is gone (plugin removed) can never be cleaned up,
      // so it is dropped. Any other remove failure keeps the row as a failed,
      // uncleaned provision: deleting it would orphan the VM, and the
      // provisioner's reconcile retries the cleanup from it.
      const registered = registeredAdapters(info.projectID).some(([type]) => type === info.type)
      if (!registered) {
        yield* Effect.logError("adapter not available when removing workspace", { type: row.type })
        yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).pipe(Effect.orDie)
        return info
      }
      const removed = yield* WorkspaceAdapterRuntime.remove(info).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError("workspace adapter remove failed; keeping row for retry", {
            workspaceID: id,
            error: String(cause),
          }).pipe(Effect.as(false)),
        ),
      )
      if (!removed) {
        const now = Date.now()
        const state =
          ProvisionState.read(info.extra) ??
          ProvisionState.begin({ kind: "new", mode: "empty", now, bootDeadlineMs: 0 })
        // Marked as a failed *new* job whatever it was before: its cleanup
        // then deletes the volume too, and routing never recovers it.
        const marked = { ...ProvisionState.fail(state, "Removal failed", now), kind: "new" as const }
        yield* setExtra(id, ProvisionState.write(info.extra, marked))
        return
      }

      yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).pipe(Effect.orDie)
      return info
    })

    const status = Effect.fn("Workspace.status")(function* () {
      return [...connections.values()]
    })

    const isSyncing = Effect.fn("Workspace.isSyncing")(function* (workspaceID: WorkspaceV2.ID) {
      const exists = yield* FiberMap.has(syncFibers, workspaceID)
      return exists && connections.get(workspaceID)?.status !== "error"
    })

    // Readiness for proxying: a live fiber is not enough, because a fiber is
    // already running while the target is still booting (every connect failure
    // keeps the loop alive in retry). Only a connected stream proves the
    // remote is answering requests.
    const isSynced = Effect.fn("Workspace.isSynced")(function* (workspaceID: WorkspaceV2.ID) {
      const exists = yield* FiberMap.has(syncFibers, workspaceID)
      return exists && (reachable.has(workspaceID) || connections.get(workspaceID)?.status === "connected")
    })

    const waitForSync = Effect.fn("Workspace.waitForSync")(function* (
      workspaceID: WorkspaceV2.ID,
      state: Record<string, number>,
      signal?: AbortSignal,
      timeout = TIMEOUT,
    ) {
      if (yield* synced(db, state)) return

      yield* Effect.catch(
        waitUntilSynced({ db, workspaceID, state, signal, timeout }),
        (): Effect.Effect<never, WaitForSyncError> =>
          signal?.aborted
            ? Effect.fail(
                new SyncAbortedError({
                  message: signal.reason instanceof Error ? signal.reason.message : "Request aborted",
                  cause: signal.reason,
                }),
              )
            : Effect.fail(
                new SyncTimeoutError({
                  message: `Timed out waiting for sync fence: ${JSON.stringify(state)}`,
                  state,
                }),
              ),
      )
    })

    const startWorkspaceSyncing = Effect.fn("Workspace.startWorkspaceSyncing")(function* (projectID: ProjectV2.ID) {
      const rows = yield* db
        .selectDistinct({ workspace: WorkspaceTable })
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, projectID))
        .pipe(Effect.orDie)

      for (const { workspace } of rows) {
        yield* startSync(fromRow(workspace)).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              setStatus(workspace.id, "error")
            }),
          ),
          Effect.forkDetach,
        )
      }
    })

    return Service.of({
      create,
      insert,
      provisionVM,
      setExtra,
      claim,
      sessionWarp,
      list,
      syncList,
      get,
      getByDirectory,
      all,
      remove,
      status,
      isSyncing,
      isSynced,
      waitForSync,
      startWorkspaceSyncing,
      startSync,
      stopSync,
    })
  }),
)

const TIMEOUT = 5000

// create() blocks until the workspace's sync stream connects, which for a
// cold MicroVM boot takes far longer than the default fence wait. Deployments
// extend this via OPENCODE_WORKSPACE_CREATE_TIMEOUT_MS (wake budget).
function millis(key: string, fallback: number) {
  const value = Number(process.env[key] ?? fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const connectTimeoutMs = () => millis("OPENCODE_WORKSPACE_CONNECT_TIMEOUT_MS", 5_000)
const historyTimeoutMs = () => millis("OPENCODE_WORKSPACE_HISTORY_TIMEOUT_MS", 15_000)
const streamIdleMs = () => millis("OPENCODE_WORKSPACE_STREAM_IDLE_MS", 30_000)

function createTimeout() {
  const value = Number(process.env["OPENCODE_WORKSPACE_CREATE_TIMEOUT_MS"] ?? TIMEOUT)
  return Number.isFinite(value) && value > 0 ? value : TIMEOUT
}

type HistoryEvent = {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: Record<string, unknown>
}

function waitUntilSynced(input: {
  db: Database.Interface["db"]
  workspaceID: WorkspaceV2.ID
  state: Record<string, number>
  signal?: AbortSignal
  timeout: number
}): Effect.Effect<void, unknown> {
  return Effect.suspend(() =>
    waitEvent({
      timeout: input.timeout,
      signal: input.signal,
      fn(event) {
        return event.workspace === input.workspaceID || event.payload.type === "sync"
      },
    }).pipe(
      Effect.andThen(synced(input.db, input.state)),
      Effect.flatMap((done): Effect.Effect<void, unknown> => (done ? Effect.void : waitUntilSynced(input))),
    ),
  )
}

function synced(db: Database.Interface["db"], state: Record<string, number>): Effect.Effect<boolean> {
  const ids = Object.keys(state)
  if (ids.length === 0) return Effect.succeed(true)

  return db
    .select({
      id: EventSequenceTable.aggregate_id,
      seq: EventSequenceTable.seq,
    })
    .from(EventSequenceTable)
    .where(inArray(EventSequenceTable.aggregate_id, ids))
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const done = Object.fromEntries(rows.map((row) => [row.id, row.seq])) as Record<string, number>
        return ids.every((id) => (done[id] ?? -1) >= state[id])
      }),
    )
}

function route(url: string | URL, path: string) {
  const next = new URL(url)
  next.pathname = `${next.pathname.replace(/\/$/, "")}${path}`
  next.search = ""
  next.hash = ""
  return next
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Auth.node,
    Session.node,
    SessionPrompt.node,
    httpClient,
    EventV2Bridge.node,
    Vcs.node,
    RuntimeFlags.node,
    FSUtil.node,
    Database.node,
  ],
})

export * as Workspace from "./workspace"
