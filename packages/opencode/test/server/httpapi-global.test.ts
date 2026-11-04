import { $ } from "bun"
import { AppProcess } from "@opencode-ai/core/process"
import { SessionExecution } from "@opencode-ai/core/session/execution"
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
import { createServer, type Server } from "node:http"
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
import { findChrome } from "@/preview/audit/chrome"

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

  it.live("website report requires a directory", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.previewReport).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({})),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toMatchObject({ success: false })
    }),
  )

  it.live("website report of the preview asks for a running preview", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-seo-preview-")))
      const response = yield* HttpClientRequest.post(GlobalPaths.previewReport).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ directory: dir })),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Start the preview before running an audit." })
    }),
  )

  it.live("website report rejects an address that is not a website", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-seo-url-")))
      const response = yield* HttpClientRequest.post(GlobalPaths.previewReport).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ directory: dir, url: "not a site" })),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toMatchObject({ success: false, error: "Enter a website address, like example.com." })
    }),
  )

  it.live(
    "website report audits a site and reports its technical facts and findings",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-seo-site-")))
        const site = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<Server>((resolve) => {
                const server = createServer((req, res) => {
                  if (req.url !== "/") {
                    res.writeHead(404)
                    res.end()
                    return
                  }
                  res.writeHead(200, { "content-type": "text/html", server: "test" })
                  res.end("<html><head><title>Test site</title></head><body><a href=\"/gone\">x</a></body></html>")
                })
                server.listen(0, "127.0.0.1", () => resolve(server))
              }),
          ),
          (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        )
        const address = site.address()
        const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`
        const response = yield* HttpClientRequest.post(GlobalPaths.previewReport).pipe(
          HttpClientRequest.setBody(HttpBody.jsonUnsafe({ directory: dir, url, formFactor: "desktop", locale: "de" })),
          HttpClient.execute,
        )
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const body = (yield* response.json) as {
          success: boolean
          report?: { url: string; preview: boolean; formFactor: string; technical?: { status: number; title?: string }; checks: { id: string }[] }
        }

        expect(response.status).toBe(200)
        expect(body.success).toBe(true)
        expect(body.report).toMatchObject({ url, preview: false, formFactor: "desktop" })
        expect(body.report?.technical).toMatchObject({ status: 200, title: "Test site" })
        expect(body.report?.checks.map((check) => check.id)).toEqual(expect.arrayContaining(["broken-links", "no-https"]))
      }).pipe(Effect.scoped),
    { timeout: 180_000 },
  )

  it.live("report PDF requires the report page", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-seo-pdf-")))
      const response = yield* HttpClientRequest.post(GlobalPaths.previewPdf).pipe(
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ directory: dir })),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "No report provided" })
    }),
  )

  // Printing needs a Chrome on the machine; without one only the request checks above run.
  ;(findChrome() ? it.live : it.live.skip)(
    "report PDF prints the page with Chrome",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-seo-pdf-")))
        const response = yield* HttpClientRequest.post(GlobalPaths.previewPdf).pipe(
          HttpClientRequest.setBody(HttpBody.jsonUnsafe({ directory: dir, html: "<h1>Website audit</h1>" })),
          HttpClient.execute,
        )
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const body = (yield* response.json) as { success: boolean; base64?: string }

        expect(response.status).toBe(200)
        expect(body.success).toBe(true)
        expect(Buffer.from(body.base64 ?? "", "base64").subarray(0, 5).toString()).toBe("%PDF-")
      }),
    { timeout: 90_000 },
  )
})

