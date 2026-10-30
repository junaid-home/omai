import { PreviewCapability } from "@opencode-ai/core/preview-capability"
import { AppProcess } from "@opencode-ai/core/process"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { InstanceStateStore } from "@opencode-ai/core/instance-state/store"
import { AuthSession } from "../../src/auth/session"
import { UserState } from "@opencode-ai/core/user-state"
import { mediaHandlers } from "../../src/server/routes/instance/httpapi/handlers/media"
import { userStateHandlers } from "../../src/server/routes/instance/httpapi/handlers/user-state"
import { adminHandlers } from "../../src/server/routes/instance/httpapi/handlers/admin"
import { NodeHttpServer } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { Installation } from "../../src/installation"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authHandlers } from "../../src/server/routes/instance/httpapi/handlers/auth"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"
import { Workspace } from "@/control-plane/workspace"

const input = MoveSession.Input.make({
  sessionID: SessionV2.ID.make("ses_move"),
  destination: { directory: AbsolutePath.make("/destination") },
  moveChanges: true,
})
const called = Ref.makeUnsafe<MoveSession.Input | undefined>(undefined)

// The global file and preview endpoints sit behind workspace routing; these
// tests exercise the control plane itself, so requests stay local.
const passthroughWorkspaceRouting = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: process.cwd() }))),
  ),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([
      controlHandlers,
      controlPlaneHandlers,
      globalHandlers,
      authHandlers,
      mediaHandlers,
      userStateHandlers,
      adminHandlers,
    ]),
    Layer.provide([authorizationLayer, schemaErrorLayer, passthroughWorkspaceRouting, Layer.mock(Session.Service)({})]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Workspace.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(SessionExecution.Service)({})),
  Layer.provide(Layer.mock(AppProcess.Service)({})),
  Layer.provide(Layer.mock(Project.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(
    Layer.mock(MoveSession.Service)({
      moveSession: (value) => Ref.set(called, value),
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
  Layer.provide(AuthSession.layer),
  Layer.provide(UserState.layer),
  Layer.provide(PreviewCapability.layer),
  Layer.provide(LayerNode.compile(InstanceStateStore.node)),
  Layer.provideMerge(LayerNode.compile(LayerNode.group([Database.node, FSUtil.node]))),
)
const it = testEffect(apiLayer)

describe("control-plane HttpApi", () => {
  it.live("moves a session through the root control-plane route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/experimental/control-plane/move-session").pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe(input)),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(yield* Ref.get(called)).toEqual(input)
    }),
  )
})
