import { PreviewCapability } from "@opencode-ai/core/preview-capability"
import { PreviewHttp } from "@/preview/http"
import { StaticPreview } from "@/preview/static"
import { Database } from "@opencode-ai/core/database/database"
import { CentralStorage } from "@opencode-ai/core/storage/central"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Authentication } from "@opencode-ai/core/authentication"
import { sql } from "drizzle-orm"
import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { gitInitRepo } from "@/project/project"
import { Effect, Layer, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"
import { mkdir } from "fs/promises"
import path from "path"
import { startDevServer, stopDevServer, getDevServerStatus, touchDevServer } from "@/preview/server"
import { auditPreview } from "@/preview/lighthouse"
import { ProjectArchive } from "@/server/project-archive"

function asError(err: unknown): Error {
  if (typeof err === "object" && err !== null && "message" in err) {
    return new Error(String(err.message))
  }
  return new Error(String(err))
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const previews = yield* PreviewCapability.Service
    const { db } = yield* Database.Service
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const fs = yield* FSUtil.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      const available = yield* Effect.all(
        [db.execute(sql`select 1`), Effect.tryPromise(() => CentralStorage.check())],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("3 seconds"), Effect.option)
      return available._tag === "Some"
        ? HttpServerResponse.jsonUnsafe(
            { healthy: true, version: InstallationVersion },
            { headers: { "Cache-Control": "no-store" } },
          )
        : HttpServerResponse.jsonUnsafe({ healthy: false }, { status: 503, headers: { "Cache-Control": "no-store" } })
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handleRaw("health", health)
      .handle("live", () => Effect.succeed({ healthy: true as const, version: InstallationVersion }))
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
      .handleRaw(
        "fileCreate",
        Effect.fn("GlobalHttpApi.fileCreate")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
          const request = ctx.request
          const url = new URL(request.url, "http://localhost")
          const contentType = (request.headers["content-type"] ?? "").toLowerCase()
          const queryPath = url.searchParams.get("path")
          let projectPath = queryPath ? decodeURIComponent(queryPath) : undefined
          let zipData: Uint8Array | undefined

          if (contentType.includes("application/json")) {
            const text = yield* Effect.orDie(request.text)
            const json = parseBody(text) as { path?: string; data?: number[] } | undefined
            if (!json?.path) {
              return HttpServerResponse.jsonUnsafe(
                { success: false, errors: [{ message: "Invalid request body" }] },
                { status: 400 },
              )
            }
            projectPath = json.path
            if (Array.isArray(json.data) && json.data.length > 0) zipData = new Uint8Array(json.data)
          } else {
            if (!projectPath) {
              return HttpServerResponse.jsonUnsafe(
                { success: false, errors: [{ message: "Invalid request body" }] },
                { status: 400 },
              )
            }
            const buffer = yield* Effect.orDie(request.arrayBuffer)
            if (buffer.byteLength > 0) zipData = new Uint8Array(buffer)
          }

          if (!projectPath) return HttpServerResponse.empty({ status: 400 })
          const requestedPath = projectPath
          const safePath = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(requestedPath)).pipe(
            Effect.option,
          )
          if (safePath._tag === "None") return HttpServerResponse.empty({ status: 403 })
          projectPath = safePath.value

          if (zipData && zipData.length > ProjectArchive.limits.archiveBytes) {
            return HttpServerResponse.jsonUnsafe(
              { success: false, errors: [{ message: "Zip file must be under 200MB" }] },
              { status: 400 },
            )
          }
          const destination = projectPath
          const extracted = yield* Effect.tryPromise(async () => {
            if (zipData) return ProjectArchive.extract(zipData, destination)
            await ProjectArchive.assertEmptyDestination(destination)
            await mkdir(destination, { recursive: true })
            return 0
          }).pipe(
            Effect.match({
              onSuccess: (files) => ({ success: true as const, files }),
              onFailure: (error) => ({ success: false as const, error: asError(error.cause).message }),
            }),
          )
          if (!extracted.success) {
            return HttpServerResponse.jsonUnsafe(
              { success: false, errors: [{ message: extracted.error }] },
              { status: 400 },
            )
          }
          const gitInit = yield* gitInitRepo(projectPath).pipe(
            Effect.provideService(FSUtil.Service, fs),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.map(() => null as Error | null),
            Effect.catch((err) => Effect.succeed(asError(err))),
          )
          if (gitInit) {
            return HttpServerResponse.jsonUnsafe(
              { success: false, errors: [{ message: gitInit.message }] },
              { status: 400 },
            )
          }
          return HttpServerResponse.jsonUnsafe({ success: true, path: projectPath, files: extracted.files, git: true })
        }),
      )
      .handleRaw(
        "previewStart",
        Effect.fn("GlobalHttpApi.previewStart")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
          const body = yield* Effect.orDie(ctx.request.json) as Effect.Effect<{ directory: string }>
          if (!body?.directory)
            return HttpServerResponse.jsonUnsafe({ success: false, error: "No directory provided" }, { status: 400 })
          const safePath = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(body.directory)).pipe(
            Effect.option,
          )
          if (safePath._tag === "None") return HttpServerResponse.empty({ status: 403 })
          body.directory = safePath.value
          const start = yield* Effect.tryPromise({
            try: () => startDevServer(body.directory),
            catch: (err) => err,
          }).pipe(
            Effect.match({
              onSuccess: (result) => ({ ok: true as const, result }),
              onFailure: (err) => ({ ok: false as const, error: err }),
            }),
          )
          if (!start.ok) {
            return HttpServerResponse.jsonUnsafe(
              {
                success: false,
                error: start.error instanceof Error ? start.error.message : "Failed to start dev server",
              },
              { status: 400 },
            )
          }
          const status = getDevServerStatus(body.directory)
          if (!status.running || !status.port)
            return HttpServerResponse.jsonUnsafe(
              { success: false, error: "Dev server failed to start" },
              { status: 400 },
            )
          const hostname = process.env.OPENCODE_HOST || status.hostname || "localhost"
          const proto = ctx.request.headers["x-forwarded-proto"] ?? "http"
          const scheme = proto === "wss" ? "https" : proto
          const host = ctx.request.headers["host"] ?? hostname
          const isolated = PreviewHttp.config()
          if (isolated) {
            const principal = yield* Authentication.Current
            if (!principal) return HttpServerResponse.empty({ status: 401 })
            const grant = yield* previews
              .issue({
                userID: principal.userID,
                sessionID: principal.sessionID,
                port: status.port,
                directory: safePath.value,
                origin: isolated.origin,
              })
              .pipe(Effect.orDie)
            const url = `${isolated.origin}/global/preview/proxy/${status.port}/?ticket=${encodeURIComponent(grant.token)}`
            return HttpServerResponse.jsonUnsafe(
              { success: true, url, framework: start.result.framework },
              { headers: { "Cache-Control": "no-store" } },
            )
          }
          const url = `${scheme}://${host}/global/preview/proxy/${status.port}`
          return HttpServerResponse.jsonUnsafe({ success: true, url, framework: start.result.framework })
        }),
      )
      .handleRaw(
        "previewStatic",
        Effect.fn("GlobalHttpApi.previewStatic")(function* (ctx) {
          const isolated = PreviewHttp.config()
          const principal = yield* Authentication.Current
          if (!isolated || !principal) return HttpServerResponse.empty({ status: 401 })
          const payload = yield* ctx.request.json.pipe(Effect.option)
          if (payload._tag === "None") return HttpServerResponse.empty({ status: 400 })
          const decoded = Schema.decodeUnknownOption(Schema.Struct({ directory: Schema.String, html: Schema.String }))(
            payload.value,
          )
          if (decoded._tag === "None") return HttpServerResponse.empty({ status: 400 })
          const snapshot = yield* StaticPreview.write(decoded.value.directory, decoded.value.html).pipe(Effect.result)
          if (snapshot._tag === "Failure")
            return HttpServerResponse.jsonUnsafe(
              { error: snapshot.failure.message },
              { status: snapshot.failure.status },
            )
          const grant = yield* previews
            .issue({
              userID: principal.userID,
              sessionID: principal.sessionID,
              port: 0,
              directory: snapshot.success.file,
              origin: isolated.origin,
            })
            .pipe(Effect.orDie)
          return HttpServerResponse.jsonUnsafe(
            { url: `${isolated.origin}/static/${snapshot.success.id}/?ticket=${encodeURIComponent(grant.token)}` },
            { headers: { "Cache-Control": "no-store" } },
          )
        }),
      )
      .handleRaw(
        "previewStop",
        Effect.fn("GlobalHttpApi.previewStop")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
          const body = yield* Effect.orDie(ctx.request.json) as Effect.Effect<{ directory: string }>
          if (!body?.directory) return HttpServerResponse.jsonUnsafe({ success: false }, { status: 400 })
          const safePath = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(body.directory)).pipe(
            Effect.option,
          )
          if (safePath._tag === "None") return HttpServerResponse.empty({ status: 403 })
          return HttpServerResponse.jsonUnsafe({ success: stopDevServer(safePath.value) })
        }),
      )
      .handleRaw(
        "previewStatus",
        Effect.fn("GlobalHttpApi.previewStatus")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
          const url = new URL(ctx.request.url, "http://localhost")
          const directory = url.searchParams.get("directory")
          if (!directory) return HttpServerResponse.jsonUnsafe({ running: false })
          const safePath = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(directory)).pipe(
            Effect.option,
          )
          if (safePath._tag === "None") return HttpServerResponse.empty({ status: 403 })
          return HttpServerResponse.jsonUnsafe(getDevServerStatus(safePath.value))
        }),
      )
      .handle(
        "previewHeartbeat",
        Effect.fn("GlobalHttpApi.previewHeartbeat")(function* (ctx: { payload: { directory: string } }) {
          const directory = yield* Effect.promise(() => CentralStorage.resolveWorkspace(ctx.payload.directory))
          touchDevServer(directory)
          return { success: true }
        }),
      )
      .handleRaw(
        "previewAudit",
        Effect.fn("GlobalHttpApi.previewAudit")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
          const body = yield* Effect.orDie(ctx.request.json) as Effect.Effect<{
            directory?: string
            formFactor?: "mobile" | "desktop"
          }>
          const directory = body?.directory
          if (!directory)
            return HttpServerResponse.jsonUnsafe({ success: false, error: "No directory provided" }, { status: 400 })
          const safePath = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(directory)).pipe(
            Effect.option,
          )
          if (safePath._tag === "None") return HttpServerResponse.empty({ status: 403 })
          const formFactor = body.formFactor === "desktop" ? "desktop" : "mobile"
          const audit = yield* Effect.tryPromise({
            try: () => auditPreview(safePath.value, formFactor),
            catch: (err) => err,
          }).pipe(
            Effect.match({
              onSuccess: (result) => ({ ok: true as const, result }),
              onFailure: (err) => ({ ok: false as const, error: err }),
            }),
          )
          if (!audit.ok)
            return HttpServerResponse.jsonUnsafe(
              {
                success: false,
                error: audit.error instanceof Error ? audit.error.message : "The audit could not be run.",
              },
              { status: 400 },
            )
          return HttpServerResponse.jsonUnsafe({ success: true, result: audit.result })
        }),
      )
  }),
).pipe(Layer.provide(LayerNode.compile(CrossSpawnSpawner.node)))
