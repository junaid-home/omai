import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.optional(Schema.String),
})

const GlobalFileCreateInput = Schema.Struct({
  path: Schema.String,
  data: Schema.optional(Schema.Array(Schema.Number)),
})

const GlobalFileCreateResult = Schema.Struct({
  success: Schema.Boolean,
  path: Schema.String,
  files: Schema.Number,
  git: Schema.Boolean,
})

const LighthouseFinding = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  display: Schema.String,
  score: Schema.NullOr(Schema.Number),
})

const LighthouseAuditResult = Schema.Struct({
  url: Schema.String,
  fetch_time: Schema.String,
  categories: Schema.Struct({
    performance: Schema.NullOr(Schema.Number),
    accessibility: Schema.NullOr(Schema.Number),
    best_practices: Schema.NullOr(Schema.Number),
    seo: Schema.NullOr(Schema.Number),
    agentic_browsing: Schema.NullOr(Schema.Number),
  }),
  metrics: Schema.Struct({
    fcp: Schema.NullOr(Schema.String),
    lcp: Schema.NullOr(Schema.String),
    tbt: Schema.NullOr(Schema.String),
    cls: Schema.NullOr(Schema.String),
    si: Schema.NullOr(Schema.String),
  }),
  failed: Schema.Array(LighthouseFinding),
  agentic_browsing: Schema.NullOr(
    Schema.Struct({
      passed: Schema.Number,
      total: Schema.Number,
      audits: Schema.Array(LighthouseFinding),
    }),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  fileCreate: "/global/file/create",
  previewStart: "/global/preview/start",
  previewStop: "/global/preview/stop",
  previewStatus: "/global/preview/status",
  previewHeartbeat: "/global/preview/heartbeat",
  previewAudit: "/global/preview/audit",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("live", "/global/live", { success: GlobalHealth }),
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OMAI+ server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OMAI+ system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OMAI+ configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OMAI+ configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OMAI+ instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: [HttpApiSchema.NoContent, GlobalUpgradeInput],
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade OMAI+",
          description: "Upgrade OMAI+ to the specified version or latest if not specified.",
        }),
      ),
      HttpApiEndpoint.post("fileCreate", GlobalPaths.fileCreate, {
        payload: GlobalFileCreateInput,
        success: described(GlobalFileCreateResult, "Directory created, zip extracted, and git repository initialized"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.file.create",
          summary: "Create directory, optionally extract a zip, and initialize git",
          description:
            "Create a directory at the specified path, extract zip contents into it when zip data is provided, and initialize a fresh git repository with an initial commit.",
        }),
      ),
      HttpApiEndpoint.post("previewStatic", "/global/preview/static", {
        payload: Schema.Struct({ directory: Schema.String, html: Schema.String }),
        success: Schema.Struct({ url: Schema.String }),
      }),
      HttpApiEndpoint.post("previewStart", GlobalPaths.previewStart, {
        payload: Schema.Struct({ directory: Schema.String }),
        success: Schema.Struct({
          success: Schema.Boolean,
          url: Schema.optional(Schema.String),
          framework: Schema.optional(Schema.String),
          error: Schema.optional(Schema.String),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preview.start",
          summary: "Start preview dev server",
          description: "Auto-detect project type and start the dev server for preview.",
        }),
      ),
      HttpApiEndpoint.post("previewStop", GlobalPaths.previewStop, {
        payload: Schema.Struct({ directory: Schema.String }),
        success: Schema.Struct({ success: Schema.Boolean }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preview.stop",
          summary: "Stop preview dev server",
          description: "Stop the running dev server for the current project.",
        }),
      ),
      HttpApiEndpoint.get("previewStatus", GlobalPaths.previewStatus, {
        success: Schema.Struct({
          running: Schema.Boolean,
          port: Schema.optional(Schema.Number),
          framework: Schema.optional(Schema.String),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preview.status",
          summary: "Get preview status",
          description: "Get the current status of the dev server for the current project.",
        }),
      ),
      HttpApiEndpoint.post("previewHeartbeat", GlobalPaths.previewHeartbeat, {
        payload: Schema.Struct({ directory: Schema.String }),
        success: Schema.Struct({ success: Schema.Boolean }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preview.heartbeat",
          summary: "Keep preview dev server alive",
          description:
            "Refresh the idle lease for the running dev server so it stays alive while the project is active.",
        }),
      ),
      HttpApiEndpoint.post("previewAudit", GlobalPaths.previewAudit, {
        payload: Schema.Struct({
          directory: Schema.String,
          formFactor: Schema.optional(Schema.Union([Schema.Literal("mobile"), Schema.Literal("desktop")])),
        }),
        success: Schema.Struct({
          success: Schema.Boolean,
          result: Schema.optional(LighthouseAuditResult),
          error: Schema.optional(Schema.String),
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preview.audit",
          summary: "Audit the preview with Google Lighthouse",
          description:
            "Run Google Lighthouse against the project's running preview dev server and return category scores, metrics and failed audits.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
