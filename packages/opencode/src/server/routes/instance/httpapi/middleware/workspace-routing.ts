import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Authentication } from "@opencode-ai/core/authentication"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import type { Target } from "@/control-plane/types"
import { Lifecycle } from "@/control-plane/lifecycle"
import { Provisioner } from "@/control-plane/provisioner"
import { ProvisionState } from "@/control-plane/provision-state"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { vmProjectsRoot } from "@/control-plane/vm-projects"
import { setVmPreviewTarget } from "@/control-plane/vm-preview-map"
import { Session } from "@/session/session"
import { HttpApiProxy } from "./proxy"
import * as Fence from "@/server/shared/fence"
import { getWorkspaceRouteSessionID, isLocalWorkspaceRoute, workspaceProxyURL } from "@/server/shared/workspace-routing"
import { NotFoundError } from "@/storage/storage"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Context, Data, Effect, Layer, Option, Schedule, Schema, Scope } from "effect"
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
  // The workspace's VM is still being created or booted by the provisioner.
  Provisioning: { readonly step: ProvisionState.State["step"] }
  ProvisionFailed: { readonly error: string }
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
  provisioner: Provisioner.Interface,
  request: HttpServerRequest.HttpServerRequest,
  workspace: Workspace.Info,
  target: RemoteTarget,
  url: URL,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Scope.Scope | Socket.WebSocketConstructor | Workspace.Service
> {
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
    const isEventStream =
      request.method === "GET" &&
      (url.pathname === "/global/event" || request.headers["accept"]?.includes("text/event-stream"))
    if (isEventStream) {
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* lifecycle.touch(workspace.id)
          yield* Effect.sleep("30 seconds")
        }).pipe(
          Effect.repeat(Schedule.spaced("30 seconds")),
          Effect.catchCause(() => Effect.void),
        ),
      )
    }
    if (headers["upgrade"]?.toLowerCase() === "websocket")
      return yield* HttpApiProxy.websocket(request, proxyURL, target.headers)
    const response = yield* HttpApiProxy.http(client, proxyURL, target.headers, request)
    // A zip upload into a VM waiting at the provisioner's upload step is the
    // step itself: its success finishes the job.
    if (
      request.method === "POST" &&
      url.pathname === "/global/file/create" &&
      response.status >= 200 &&
      response.status < 300
    )
      yield* provisioner.uploaded(workspace.id)
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
  const explicit = session?.directory || url.searchParams.get("directory") || request.headers["x-opencode-directory"]
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

const provisionWaitMs = () => {
  const value = Number(process.env["OPENCODE_PROVISION_WAIT_MS"] ?? 30_000)
  return Number.isFinite(value) && value >= 0 ? value : 30_000
}
const provisionRetryMs = () => {
  const value = Number(process.env["OPENCODE_PROVISION_RETRY_MS"] ?? 30_000)
  return Number.isFinite(value) && value >= 0 ? value : 30_000
}

// Plans a request for a workspace that may still be (re)provisioning. Requests
// wait a bounded time for the job instead of holding the boot inside one
// request; a gone VM is re-provisioned on the same row so its volume survives.
function planProvisioned(
  provisioner: Provisioner.Interface,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  workspace: Workspace.Info,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const state = ProvisionState.read(workspace.extra)
    if (state?.status === "failed") {
      if (state.kind !== "recover" || Date.now() - state.updatedAt < provisionRetryMs())
        return RequestPlan.ProvisionFailed({ error: state.error ?? "Workspace provisioning failed" })
      return yield* awaitProvisioned(provisioner, request, url, (yield* provisioner.recover(workspace)).workspaceID)
    }
    if (!ProvisionState.proxyable(state)) return yield* awaitProvisioned(provisioner, request, url, workspace.id)
    const planned = yield* planWorkspaceRequest(request, url, workspace)
    if (planned._tag !== "WorkspaceGone") return planned
    if (!Flag.OPENCODE_WORKSPACE_ADAPTER) return RequestPlan.UnavailableWorkspace()
    return yield* awaitProvisioned(provisioner, request, url, (yield* provisioner.recover(workspace)).workspaceID)
  })
}

function awaitProvisioned(
  provisioner: Provisioner.Interface,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  workspaceID: WorkspaceV2.ID,
): Effect.Effect<RequestPlan, never, Workspace.Service> {
  return Effect.gen(function* () {
    const job = yield* provisioner.await(workspaceID, provisionWaitMs())
    if (!job) return RequestPlan.UnavailableWorkspace()
    if (job.status === "failed")
      return RequestPlan.ProvisionFailed({ error: job.error ?? "Workspace provisioning failed" })
    if (!ProvisionState.proxyable(job)) return RequestPlan.Provisioning({ step: job.step })
    const fresh = yield* Workspace.Service.use((svc) => svc.get(workspaceID))
    if (!fresh) return RequestPlan.UnavailableWorkspace()
    const planned = yield* planWorkspaceRequest(request, url, fresh)
    // Gone again straight after provisioning: report progress rather than loop.
    if (planned._tag === "WorkspaceGone") return RequestPlan.Provisioning({ step: "creating" })
    return planned
  })
}

function planRequest(
  request: HttpServerRequest.HttpServerRequest,
  session: Session.Info | undefined,
  provisioner: Provisioner.Interface,
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
      return yield* planProvisioned(provisioner, request, url, workspace)
    }

    // Directory-scoped clients (the app) never select a workspace explicitly.
    // Resolve the workspace owning the requested directory server-side,
    // provisioning one on first open when an auto-provision adapter is set.
    if (!workspaceID && !envWorkspaceID && !shouldStayOnControlPlane(request, url)) {
      const resolved = yield* resolveRequestDirectory(request, url, session)
      if (resolved) {
        const owned = yield* Workspace.Service.use((svc) => svc.getByDirectory(resolved))
        if (owned) return yield* planProvisioned(provisioner, request, url, owned)
        if (Flag.OPENCODE_WORKSPACE_ADAPTER) {
          const principal = yield* Authentication.Current
          const job = yield* provisioner.start({
            directory: resolved,
            mode: "empty",
            owner: principal && { userID: principal.userID, username: principal.username, email: principal.email },
          })
          return yield* awaitProvisioned(provisioner, request, url, job.workspaceID)
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
  provisioner: Provisioner.Interface,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext>,
  plan: RequestPlan,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Scope.Scope | Socket.WebSocketConstructor | Workspace.Service
> {
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
    Remote: ({ request, workspace, target, url }) =>
      proxyRemote(client, lifecycle, provisioner, request, workspace, target, url),
    Provisioning: ({ step }) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { code: "workspace_provisioning", step },
          { status: 503, headers: { "retry-after": "2" } },
        ),
      ),
    ProvisionFailed: ({ error }) =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ code: "workspace_failed", error }, { status: 503 })),
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
      effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory, workspaceID }))),
  })
}

function routeHttpApiWorkspace<E>(
  client: HttpClient.HttpClient,
  lifecycle: Lifecycle.Interface,
  provisioner: Provisioner.Interface,
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
    const plan = yield* planRequest(request, session, provisioner)
    return yield* routeWorkspace(client, lifecycle, provisioner, effect, plan)
  })
}

export const workspaceRoutingLayer = Layer.effect(
  WorkspaceRoutingMiddleware,
  Effect.gen(function* () {
    const makeWebSocket = yield* Socket.WebSocketConstructor
    const workspace = yield* Workspace.Service
    const client = yield* HttpClient.HttpClient
    const lifecycle = yield* Lifecycle.Service
    const provisioner = yield* Provisioner.Service
    return WorkspaceRoutingMiddleware.of((effect) =>
      Effect.sync(Provisioner.touchDemand).pipe(
        Effect.andThen(routeHttpApiWorkspace(client, lifecycle, provisioner, effect)),
      ).pipe(
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
        Effect.provideService(Workspace.Service, workspace),
      ),
    )
  }),
)
