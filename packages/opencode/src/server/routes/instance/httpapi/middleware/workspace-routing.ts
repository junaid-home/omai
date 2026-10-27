import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Authentication } from "@opencode-ai/core/authentication"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import type { Target } from "@/control-plane/types"
import { Lifecycle } from "@/control-plane/lifecycle"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { vmProjectsRoot } from "@/control-plane/vm-projects"
import { setVmPreviewTarget } from "@/control-plane/vm-preview-map"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { HttpApiProxy } from "./proxy"
import * as Fence from "@/server/shared/fence"
import { getWorkspaceRouteSessionID, isLocalWorkspaceRoute, workspaceProxyURL } from "@/server/shared/workspace-routing"
import { NotFoundError } from "@/storage/storage"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Context, Data, Deferred, Effect, Layer, Option, Schedule, Schema, Scope } from "effect"
import { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InvalidRequestError } from "../errors"

// Query fields this middleware reads from the URL. Spread into every
// endpoint query schema in groups that apply WorkspaceRoutingMiddleware,
// otherwise HttpApi rejects requests carrying these params with 400.
// HttpApiMiddleware in effect-smol cannot declare query params today —
// remove this once upstream supports middleware-declared query schemas.
export const WorkspaceRoutingQueryFields = {
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
}

export const WorkspaceRoutingQuery = Schema.Struct(WorkspaceRoutingQueryFields)

type RemoteTarget = Extract<Target, { type: "remote" }>

type RequestPlan = Data.TaggedEnum<{
  InvalidWorkspace: {}
  MissingWorkspace: { readonly workspaceID: WorkspaceV2.ID }
  UnavailableWorkspace: {}
  Local: { readonly directory: string; readonly workspaceID?: WorkspaceV2.ID }
  // The workspace row's VM no longer exists (deleted out-of-band, or a create
  // that died after inserting the row). Surfaced instead of reusing the dead
  // target, so the open path can drop the row and re-provision.
  WorkspaceGone: { readonly workspace: Workspace.Info }
  Remote: {
    readonly request: HttpServerRequest.HttpServerRequest
    readonly workspace: Workspace.Info
    readonly target: RemoteTarget
    readonly url: URL
  }
}>
const RequestPlan = Data.taggedEnum<RequestPlan>()
const InvalidWorkspaceID = Symbol("InvalidWorkspaceID")

export class WorkspaceRouteContext extends Context.Service<
  WorkspaceRouteContext,
  {
    readonly directory: string
    readonly workspaceID?: WorkspaceV2.ID
  }
>()("@opencode/ExperimentalHttpApiWorkspaceRouteContext") {}

export class WorkspaceRoutingMiddleware extends HttpApiMiddleware.Service<
  WorkspaceRoutingMiddleware,
  {
    provides: WorkspaceRouteContext
    requires: Session.Service
  }
>()("@opencode/ExperimentalHttpApiWorkspaceRouting") {}

function requestURL(request: HttpServerRequest.HttpServerRequest): URL {
  return new URL(request.url, "http://localhost")
}

function configuredWorkspaceID(): WorkspaceV2.ID | undefined {
  return Flag.OPENCODE_WORKSPACE_ID ? WorkspaceV2.ID.make(Flag.OPENCODE_WORKSPACE_ID) : undefined
}

function selectedWorkspaceID(url: URL, sessionWorkspaceID?: WorkspaceV2.ID): WorkspaceV2.ID | undefined {
  const workspaceParam = url.searchParams.get("workspace")
  return sessionWorkspaceID ?? (workspaceParam ? WorkspaceV2.ID.make(workspaceParam) : undefined)
}

function selectedV2WorkspaceID(
  url: URL,
  sessionWorkspaceID?: WorkspaceV2.ID,
): WorkspaceV2.ID | typeof InvalidWorkspaceID | undefined {
  if (sessionWorkspaceID) return sessionWorkspaceID
  const workspaceParam = url.searchParams.get("workspace")
  if (!workspaceParam) return undefined
  const workspaceID = Schema.decodeUnknownOption(WorkspaceV2.ID)(workspaceParam)
  if (Option.isNone(workspaceID)) return InvalidWorkspaceID
  return workspaceID.value
}

function defaultDirectory(request: HttpServerRequest.HttpServerRequest, url: URL): string {
  return (
    url.searchParams.get("directory") ||
    request.headers["x-opencode-directory"] ||
    CentralStorage.workspaceRoot() ||
    process.cwd()
  )
}

// The SDK percent-encodes x-opencode-directory while query values arrive
// already decoded. Decode before comparing against workspace rows so lookups
// match the string the instance store loads with (see instance-context).
export function decodeDirectory(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function shouldStayOnControlPlane(request: HttpServerRequest.HttpServerRequest, url: URL): boolean {
  // Project deletion must run on the control plane so it can tear down the
  // associated MicroVM workspace/service/volume, not just the DB row.
  if (request.method === "DELETE" && url.pathname.startsWith("/project/")) return true
  // The session list filters by the project the serving instance resolves for
  // the directory. The control plane has no copy of a VM's files, so it
  // resolves VM paths to the global project and lists nothing; only the VM
  // sees the git repository that owns the sessions.
  if (request.method === "GET" && url.pathname === "/session" && isVmDirectory(request, url)) return false
  return isLocalWorkspaceRoute(request.method, url.pathname) || url.pathname.startsWith("/console")
}

function isVmDirectory(request: HttpServerRequest.HttpServerRequest, url: URL) {
  const vmRoot = vmProjectsRoot()
  const directory = url.searchParams.get("directory") || request.headers["x-opencode-directory"]
  return !!vmRoot && !!directory && decodeDirectory(directory).startsWith(`${vmRoot}/`)
}

function resolveWorkspace(
  id: WorkspaceV2.ID | undefined,
  envWorkspaceID: WorkspaceV2.ID | undefined,
): Effect.Effect<Workspace.Info | void, never, Workspace.Service> {
  if (!id || envWorkspaceID) return Effect.void
  return Workspace.Service.use((workspace) => workspace.get(id))
}

function missingWorkspaceResponse(id: WorkspaceV2.ID): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(`Workspace not found: ${id}`, {
    status: 500,
    contentType: "text/plain; charset=utf-8",
  })
}

function resolveTarget(workspace: Workspace.Info): Effect.Effect<Target, WorkspaceAdapterRuntime.WorkspaceGone> {
  return WorkspaceAdapterRuntime.targetOrGone(workspace)
}

function proxyRemote(
  client: HttpClient.HttpClient,
  lifecycle: Lifecycle.Interface,
  request: HttpServerRequest.HttpServerRequest,
  workspace: Workspace.Info,
  target: RemoteTarget,
  url: URL,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope | Socket.WebSocketConstructor | Workspace.Service> {
  return Effect.gen(function* () {
    // Touch first so a sweep already waiting on the lock sees the request and
    // aborts; then wake a suspended VM and hold until its sync stream is up.
    yield* lifecycle.touch(workspace.id)
    yield* Workspace.Service.use((svc) => svc.startSync(workspace)).pipe(Effect.ignore)
    yield* lifecycle.ensureRunning(workspace)
    const ready = yield* Workspace.Service.use((svc) => svc.isSynced(workspace.id))
    if (!ready) {
      return HttpServerResponse.text(`broken sync connection for workspace: ${workspace.id}`, {
        status: 503,
        contentType: "text/plain; charset=utf-8",
      })
    }
    const proxyURL = workspaceProxyURL(target.url, url)
    const headers = request.headers as Record<string, string>
    // Non-GET requests carry the directory only as a header, which the proxy
    // sanitizes away; re-attach it as a query param so the remote instance
    // resolves the same directory the control plane routed on.
    const directory = headers["x-opencode-directory"]
    if (directory && !proxyURL.searchParams.has("directory")) {
      proxyURL.searchParams.set("directory", decodeDirectory(directory))
    }
    // Keep the VM alive for as long as a long-lived stream (SSE event
    // stream) is open, so a browser tab that is merely viewing does not get
    // paused by the idle sweeper. The fiber is scoped to this request and is
    // interrupted when the client disconnects.
    const isEventStream = request.method === "GET" && (url.pathname === "/global/event" || request.headers["accept"]?.includes("text/event-stream"))
    if (isEventStream) {
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* lifecycle.touch(workspace.id)
          yield* Effect.sleep("30 seconds")
        }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.catchCause(() => Effect.void)),
      )
    }
    if (headers["upgrade"]?.toLowerCase() === "websocket") return yield* HttpApiProxy.websocket(request, proxyURL, target.headers)
    const response = yield* HttpApiProxy.http(client, proxyURL, target.headers, request)
    const sync = Fence.parse(new Headers(response.headers))
    if (sync) {
      const syncFailure = yield* Fence.wait(
        workspace.id,
        sync,
        request.source instanceof Request ? request.source.signal : undefined,
      ).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 503 }))),
      )
      if (syncFailure) return syncFailure
    }
    return response
  })
}

function planWorkspaceRequest(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  workspace: Workspace.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    // Remote targets must win over central storage: a MicroVM workspace in a
    // central deployment still proxies to the VM, whose volume holds the copy
    // of the project at the identical path. Local targets keep mapping through
    // the central storage root as before.
    // A gone VM becomes its own plan so the open path drops the stranded row
    // and re-provisions. Any other adapter failure keeps the historical
    // unavailable treatment, never gone.
    const resolved = yield* resolveTarget(workspace).pipe(
      // Map the typed gone failure to `undefined` rather than to a plan: a
      // plan here would widen the success to `Target | RequestPlan`, which
      // the type checks below cannot narrow reliably.
      Effect.catchTag("WorkspaceGone", () => Effect.succeed(undefined)),
    )
    if (resolved === undefined) return RequestPlan.WorkspaceGone({ workspace })
    if (resolved.type === "remote") {
      setVmPreviewTarget(workspace.id, {
        url: String(resolved.url),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
      })
      return RequestPlan.Remote({ request, workspace, target: resolved, url })
    }
    if (Authentication.central()) {
      if (!workspace.directory) return RequestPlan.UnavailableWorkspace()
      const directory = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(workspace.directory!)).pipe(
        Effect.option,
      )
      return Option.isSome(directory)
        ? RequestPlan.Local({ directory: directory.value, workspaceID: workspace.id })
        : RequestPlan.UnavailableWorkspace()
    }
    return RequestPlan.Local({ directory: resolved.directory, workspaceID: workspace.id })
  })
}

function resolveRequestDirectory(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  session?: Session.Info,
): Effect.Effect<string | undefined> {
  // Only an explicitly scoped directory may select or provision a workspace.
  // Directory-less base-client traffic (GET /path, /config, global file
  // creation, ...) is control-plane scoped: falling back to the server's cwd
  // there provisioned a MicroVM for the repo itself and proxied global
  // endpoints into it.
  const explicit =
    session?.directory || url.searchParams.get("directory") || request.headers["x-opencode-directory"]
  if (!explicit) return Effect.succeed(undefined)
  const directory = decodeDirectory(explicit)
  // VM-backed project paths live under the VM projects root and are not part
  // of central storage: resolve them directly so a workspace is selected or
  // provisioned and the request proxies into the VM instead of materializing
  // the project on the control plane's own disk.
  const vmRoot = vmProjectsRoot()
  if (vmRoot && directory.startsWith(`${vmRoot}/`)) {
    return Effect.succeed(directory)
  }
  return Effect.tryPromise(() => CentralStorage.resolveWorkspace(directory)).pipe(
    Effect.option,
    Effect.map((resolved) => (Option.isSome(resolved) ? resolved.value : undefined)),
  )
}

// Auto-provisioned workspaces keyed by resolved directory. The first request
// opens the workspace; concurrent requests await the same deferred, and the
// create runs detached so a client disconnect cannot leave a half-created VM.
const provisioning = new Map<string, Deferred.Deferred<Workspace.Info | undefined, never>>()

function provision(
  store: InstanceStore.Interface,
  directory: string,
): Effect.Effect<Workspace.Info | undefined, never, Workspace.Service> {
  const type = Flag.OPENCODE_WORKSPACE_ADAPTER
  if (!type) return Effect.succeed(undefined)
  return Effect.gen(function* () {
    const entry = yield* Effect.sync(() => {
      const pending = provisioning.get(directory)
      if (pending) return { deferred: pending, owner: false }
      const deferred = Deferred.makeUnsafe<Workspace.Info | undefined, never>()
      provisioning.set(directory, deferred)
      return { deferred, owner: true }
    })
    if (!entry.owner) return yield* Deferred.await(entry.deferred)

    const workspace = yield* Workspace.Service
    const attempt = Effect.gen(function* () {
      const ctx = yield* store.load({ directory })
      return yield* Workspace.Service.use((svc) =>
        svc.create({ type, branch: null, extra: null, projectID: ctx.project.id }),
      ).pipe(Effect.provideService(InstanceRef, ctx))
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("workspace auto-provision failed", { directory, error: String(cause) })
          // create() may have failed after inserting the row; reuse it so
          // later requests route remotely instead of creating a second VM.
          return yield* Workspace.Service.use((svc) => svc.getByDirectory(directory))
        }),
      ),
      Effect.provideService(Workspace.Service, workspace),
    )

    yield* entry.deferred.pipe(
      // complete (not completeWith) runs the attempt exactly once and shares
      // its result with every awaiting request; completeWith would let each
      // awaiter run its own create.
      Deferred.complete(attempt),
      Effect.ensuring(Effect.sync(() => provisioning.delete(directory))),
      Effect.forkDetach({ startImmediately: true }),
    )
    return yield* Deferred.await(entry.deferred)
  })
}

// The stored workspace's VM is gone (deleted out-of-band, or a create that
// died after inserting the row). Drop the stranded row, re-provision one for
// the same directory, and re-plan against the fresh workspace. On re-provision
// failure the original stranded row is already gone, so surface an
// Unavailable plan instead of routing into a dead target.
function recoverOrReplan(
  store: InstanceStore.Interface,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  workspace: Workspace.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  // Narrow once: the closure below re-reads the field, which the guard alone
  // does not narrow across function boundaries.
  const directory = workspace.directory
  if (!directory) return Effect.succeed(RequestPlan.UnavailableWorkspace())
  return Effect.gen(function* () {
    const workspaceService = yield* Workspace.Service
    yield* Effect.logWarning("workspace VM gone; re-provisioning", {
      workspaceID: workspace.id,
      directory,
    })
    yield* workspaceService.remove(workspace.id).pipe(
      Effect.catchCause(() => Effect.logWarning("workspace remove failed during gone-recovery", { workspaceID: workspace.id })),
    )
    const replanned = yield* provision(store, directory).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (replanned === undefined) return RequestPlan.UnavailableWorkspace()
    return yield* planWorkspaceRequest(request, url, replanned)
  })
}

function planRequest(
  request: HttpServerRequest.HttpServerRequest,
  session: Session.Info | undefined,
  store: InstanceStore.Interface,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const url = requestURL(request)
    const envWorkspaceID = configuredWorkspaceID()
    const workspaceID = url.pathname.startsWith("/api/")
      ? selectedV2WorkspaceID(url, session?.workspaceID)
      : selectedWorkspaceID(url, session?.workspaceID)
    if (workspaceID === InvalidWorkspaceID) return RequestPlan.InvalidWorkspace()
    const workspace = yield* resolveWorkspace(workspaceID, envWorkspaceID)

    if (workspaceID && workspace === undefined && !envWorkspaceID) {
      return RequestPlan.MissingWorkspace({ workspaceID })
    }

    if (workspace !== undefined && !envWorkspaceID && !shouldStayOnControlPlane(request, url)) {
      const planned = yield* planWorkspaceRequest(request, url, workspace)
      if (planned._tag !== "WorkspaceGone") return planned
      return yield* recoverOrReplan(store, request, url, workspace)
    }

    // Directory-scoped clients (the app) never select a workspace explicitly.
    // Resolve the workspace owning the requested directory server-side,
    // provisioning one on first open when an auto-provision adapter is set.
    if (!workspaceID && !envWorkspaceID && !shouldStayOnControlPlane(request, url)) {
      const resolved = yield* resolveRequestDirectory(request, url, session)
      if (resolved) {
        const owned = yield* Workspace.Service.use((svc) => svc.getByDirectory(resolved))
        // Read the in-flight map after the lookup: a visible row implies the
        // owner set it before inserting, so awaiting here holds concurrent
        // first-open requests until the workspace's sync stream connects
        // instead of proxying into a target that is not ready yet.
        const pending = provisioning.get(resolved)
        const space = pending ? yield* Deferred.await(pending) : (owned ?? (yield* provision(store, resolved)))
        if (space) {
          const planned = yield* planWorkspaceRequest(request, url, space)
          if (planned._tag !== "WorkspaceGone") return planned
          return yield* recoverOrReplan(store, request, url, space)
        }
      }
    }

    return RequestPlan.Local({
      directory: session?.directory || defaultDirectory(request, url),
      workspaceID: envWorkspaceID ?? workspaceID,
    })
  })
}

function routeWorkspace<E>(
  client: HttpClient.HttpClient,
  lifecycle: Lifecycle.Interface,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
  plan: RequestPlan,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, Scope.Scope | Socket.WebSocketConstructor | Workspace.Service> {
  return RequestPlan.$match(plan, {
    InvalidWorkspace: () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          new InvalidRequestError({
            message: "Invalid workspace query parameter",
            kind: "Query",
            field: "workspace",
          }),
          { status: 400 },
        ),
      ),
    MissingWorkspace: ({ workspaceID }) => Effect.succeed(missingWorkspaceResponse(workspaceID)),
    UnavailableWorkspace: () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "Workspace must be migrated to this instance's central workspace volume before use" },
          { status: 409 },
        ),
      ),
    Remote: ({ request, workspace, target, url }) => proxyRemote(client, lifecycle, request, workspace, target, url),
    // Both call sites intercept this before dispatch and re-provision, so a
    // WorkspaceGone reaching the router means recovery already failed; the
    // historical 503 stands in as the terminal response.
    WorkspaceGone: ({ workspace }) =>
      Effect.succeed(
        HttpServerResponse.text(`broken sync connection for workspace: ${workspace.id}`, {
          status: 503,
          contentType: "text/plain; charset=utf-8",
        }),
      ),
    Local: ({ directory, workspaceID }) =>
      effect.pipe(
        Effect.provideService(
          WorkspaceRouteContext,
          WorkspaceRouteContext.of({ directory, workspaceID }),
        ),
      ),
  })
}

function routeHttpApiWorkspace<E>(
  client: HttpClient.HttpClient,
  store: InstanceStore.Interface,
  lifecycle: Lifecycle.Interface,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Scope.Scope | Session.Service | Workspace.Service | HttpServerRequest.HttpServerRequest | Socket.WebSocketConstructor
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessionID = getWorkspaceRouteSessionID(requestURL(request))
    const session = sessionID
      ? yield* Session.Service.use((svc) => svc.get(sessionID)).pipe(
          Effect.catchIf(
            (error): error is NotFoundError => NotFoundError.isInstance(error),
            () => Effect.succeed(undefined),
          ),
          Effect.catchDefect(() => Effect.succeed(undefined)),
        )
      : undefined
    const plan = yield* planRequest(request, session, store)
    return yield* routeWorkspace(client, lifecycle, effect, plan)
  })
}

export const workspaceRoutingLayer = Layer.effect(
  WorkspaceRoutingMiddleware,
  Effect.gen(function* () {
    const makeWebSocket = yield* Socket.WebSocketConstructor
    const workspace = yield* Workspace.Service
    const store = yield* InstanceStore.Service
    const client = yield* HttpClient.HttpClient
    const lifecycle = yield* Lifecycle.Service
    return WorkspaceRoutingMiddleware.of((effect) =>
      routeHttpApiWorkspace(client, store, lifecycle, effect).pipe(
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
        Effect.provideService(Workspace.Service, workspace),
      ),
    )
  }),
)
