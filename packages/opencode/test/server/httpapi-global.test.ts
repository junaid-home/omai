import { $ } from "bun"
import { PreviewCapability } from "@opencode-ai/core/preview-capability"
import { InstanceStateStore } from "@opencode-ai/core/instance-state/store"
import { AuthSession } from "../../src/auth/session"
import { UserState } from "@opencode-ai/core/user-state"
import { mediaHandlers } from "../../src/server/routes/instance/httpapi/handlers/media"
import { userStateHandlers } from "../../src/server/routes/instance/httpapi/handlers/user-state"
import { adminHandlers } from "../../src/server/routes/instance/httpapi/handlers/admin"
import { NodeHttpServer } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { mkdtemp, readFile, readdir, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
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
import { tmpdirScoped } from "../fixture/fixture"
import { Workspace } from "@/control-plane/workspace"

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
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
  Layer.provide(AuthSession.layer),
  Layer.provide(UserState.layer),
  Layer.provide(PreviewCapability.layer),
  Layer.provide(LayerNode.compile(InstanceStateStore.node)),
  Layer.provideMerge(LayerNode.compile(LayerNode.group([Database.node, FSUtil.node, CrossSpawnSpawner.node, Project.node]))),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("upgrades to latest when the request body is omitted", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )

  it.live("creates a directory without extracting when no zip data is attached", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-file-create-")))
      const response = yield* HttpClientRequest.post(GlobalPaths.fileCreate).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ path: dir })),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ success: true, path: dir, files: 0, git: true })
      expect(yield* Effect.promise(() => stat(dir)).pipe(Effect.map((info) => info.isDirectory()))).toBe(true)
    }),
  )

  it.live("file create without a zip succeeds again on the repository it created", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-file-create-again-")))
      const dir = path.join(root, "project")
      const create = HttpClientRequest.post(GlobalPaths.fileCreate).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ path: dir })),
        HttpClient.execute,
      )

      const first = yield* create
      expect(first.status).toBe(200)
      const head = yield* Effect.promise(() => $`git -C ${dir} rev-parse HEAD`.quiet().text())

      const second = yield* create
      expect(second.status).toBe(200)
      expect(yield* second.json).toMatchObject({ success: true, path: dir, files: 0, git: true })
      expect(yield* Effect.promise(() => $`git -C ${dir} rev-parse HEAD`.quiet().text())).toBe(head)
    }),
  )

  it.live("share data for an unknown share is not found", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(GlobalPaths.shareData.replace(":shareID", "nOsUcH12"))

      expect(response.status).toBe(404)
    }),
  )

  it.live("rejects fileCreate without a path", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.fileCreate).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({})),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toMatchObject({ success: false })
    }),
  )

  it.live("rejects an existing project without changing its files or Git metadata", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const original = {
        "README.md": "existing project\n",
        ".git/config": "[core]\n\trepositoryformatversion = 0\n",
        ".git/HEAD": "ref: refs/heads/existing\n",
      }
      for (const [name, content] of Object.entries(original)) {
        yield* Effect.promise(() => Bun.write(path.join(directory, name), content))
      }
      const response = yield* HttpClientRequest.post(GlobalPaths.fileCreate).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ path: directory })),
        HttpClient.execute,
      )
      expect(response.status).toBe(400)
      expect(yield* response.json).toMatchObject({
        success: false,
        errors: [{ message: "Project destination must be a new or empty directory" }],
      })
      for (const [name, content] of Object.entries(original)) {
        expect(yield* Effect.promise(() => readFile(path.join(directory, name), "utf8"))).toBe(content)
      }
      expect((yield* Effect.promise(() => readdir(path.join(directory, ".git")))).sort()).toEqual(["HEAD", "config"])
    }),
  )

  it.live("extracts a zip, stripping a common root and skipping __MACOSX__ entries", () =>
    Effect.gen(function* () {
      const zip = new JSZip()
      zip.file("my-project/src/index.ts", "export const x = 1")
      zip.file("my-project/README.md", "# hi")
      zip.folder("__MACOSX")?.file("_.DS_Store", "junk")
      const bytes = yield* Effect.promise(() => zip.generateAsync({ type: "nodebuffer" }))

      // The handler refuses destinations behind a symlink, and macOS's tmpdir
      // lives under the /var -> /private/var link.
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-file-zip-")).then((dir) => realpath(dir)))
      const response = yield* HttpClientRequest.post(`${GlobalPaths.fileCreate}?path=${encodeURIComponent(dir)}`).pipe(
        HttpClientRequest.setBody(HttpBody.uint8Array(new Uint8Array(bytes), "application/octet-stream")),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toMatchObject({ success: true, path: dir, files: 2, git: true })
      expect(yield* Effect.promise(() => readFile(path.join(dir, "src", "index.ts"), "utf8"))).toBe(
        "export const x = 1",
      )
      expect(yield* Effect.promise(() => readFile(path.join(dir, "README.md"), "utf8"))).toBe("# hi")
      const entries = yield* Effect.promise(() => readdir(dir))
      expect(entries.filter((entry) => entry !== ".git").sort()).toEqual(["README.md", "src"])
    }),
  )
})
