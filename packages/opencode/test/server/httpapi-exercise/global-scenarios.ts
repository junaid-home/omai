import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { check, object } from "./assertions"
import { http } from "./dsl"
import type { ScenarioContext } from "./types"

function previewProject(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    yield* Effect.promise(() => mkdir(path.join(ctx.directory!, "node_modules")))
    yield* ctx.file("bun.lock", "")
    yield* ctx.file("package.json", JSON.stringify({ name: "httpapi-preview", scripts: { dev: "bun server.ts" } }))
    yield* ctx.file(
      "server.ts",
      [
        'import { createServer } from "node:http"',
        'const server = createServer((_request, response) => response.end("HTTP preview fixture"))',
        'server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready http://127.0.0.1:" + server.address().port))',
      ].join("\n"),
    )
    const { stopDevServer } = yield* Effect.promise(() => import("../../../src/preview/server"))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopDevServer(ctx.directory!)
      }),
    )
  })
}

function runningPreview(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    yield* previewProject(ctx)
    const result = yield* ctx.request("POST", { path: "/global/preview/start", body: { directory: ctx.directory } })
    check(result.status === 200, `preview fixture startup failed: ${result.text}`)
    object(result.body)
    check(result.body.success === true, "fixture preview must actually start")
  })
}

export const globalScenarios = [
  http.protected
    .get("/global/live", "omai.global.live")
    .global()
    .json(200, (body) => {
      object(body)
      check(body.healthy === true && typeof body.version === "string", "liveness must identify the running server")
    }),
  http.protected
    .post("/global/file/create", "omai.global.file.create")
    .seeded((ctx) =>
      Effect.promise(async () => {
        const { default: JSZip } = await import("jszip")
        const zip = new JSZip()
        zip.file("project/src/main.ts", "export const imported = true\n")
        return {
          directory: path.join(ctx.directory!, "imported"),
          data: Array.from(await zip.generateAsync({ type: "uint8array" })),
        }
      }),
    )
    .at((ctx) => ({
      path: "/global/file/create",
      headers: ctx.headers(),
      body: { path: ctx.state.directory, data: ctx.state.data },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(
          body.success === true && body.files === 1 && body.git === true,
          "import should extract the fixture and initialize Git",
        )
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.state.directory, "src/main.ts")).text())) ===
            "export const imported = true\n",
          "import must strip archive root and preserve bytes",
        )
        check(
          yield* Effect.promise(() => Bun.file(path.join(ctx.state.directory, ".git/HEAD")).exists()),
          "import must initialize an actual Git repository",
        )
      }),
    ),
  http.protected
    .post("/global/preview/start", "omai.preview.start")
    .seeded(previewProject)
    .at((ctx) => ({ path: "/global/preview/start", headers: ctx.headers(), body: { directory: ctx.directory } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true && typeof body.url === "string", "preview must return its running URL")
        const status = yield* ctx.request("GET", {
          path: `/global/preview/status?${new URLSearchParams({ directory: ctx.directory! })}`,
        })
        object(status.body)
        check(
          status.status === 200 && status.body.running === true && typeof status.body.port === "number",
          "started process must be registered as running",
        )
        const port = status.body.port
        const page = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()))
        check(page === "HTTP preview fixture", "started preview must serve the actual workspace process")
      }),
    ),
  http.protected
    .get("/global/preview/status", "omai.preview.status")
    .seeded(runningPreview)
    .at((ctx) => ({
      path: `/global/preview/status?${new URLSearchParams({ directory: ctx.directory! })}`,
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(body.running === true && typeof body.port === "number", "status must report the real running fixture")
    }),
  http.protected
    .post("/global/preview/heartbeat", "omai.preview.heartbeat")
    .seeded(runningPreview)
    .at((ctx) => ({ path: "/global/preview/heartbeat", headers: ctx.headers(), body: { directory: ctx.directory } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "heartbeat must acknowledge the active preview")
        const status = yield* ctx.request("GET", {
          path: `/global/preview/status?${new URLSearchParams({ directory: ctx.directory! })}`,
        })
        object(status.body)
        check(status.body.running === true, "heartbeat must preserve the running process")
      }),
    ),
  http.protected
    .post("/global/preview/stop", "omai.preview.stop")
    .seeded(runningPreview)
    .at((ctx) => ({ path: "/global/preview/stop", headers: ctx.headers(), body: { directory: ctx.directory } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "stop must acknowledge the active process")
        const status = yield* ctx.request("GET", {
          path: `/global/preview/status?${new URLSearchParams({ directory: ctx.directory! })}`,
        })
        object(status.body)
        check(status.body.running === false, "stop must remove the process from the active registry")
      }),
    ),
  http.protected
    .post("/global/preview/audit", "omai.preview.audit.notRunning")
    .at((ctx) => ({
      path: "/global/preview/audit",
      headers: ctx.headers(),
      body: { directory: ctx.directory, formFactor: "desktop" },
    }))
    .json(400, (body) => {
      object(body)
      check(
        body.success === false && body.error === "Start the preview before running an audit.",
        "audit must reject a workspace without a running preview before invoking Chromium",
      )
    }),
  http.protected
    .delete("/mcp/{name}", "omai.mcp.remove")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const added = yield* ctx.request("POST", {
          path: "/mcp",
          body: {
            name: "fixture",
            config: { type: "local", command: ["false"], enabled: false },
          },
        })
        check(added.status === 200, "fixture must register the disabled MCP server without spawning it")
        object(added.body)
        object(added.body.fixture)
        check(added.body.fixture.status === "disabled", "MCP fixture must exist before deletion")
      }),
    )
    .at((ctx) => ({ path: "/mcp/fixture", headers: ctx.headers() }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "MCP removal should acknowledge success")
        const status = yield* ctx.request("GET", { path: "/mcp" })
        object(status.body)
        check(!("fixture" in status.body), "removed dynamic MCP server must disappear from status")
        const again = yield* ctx.request("DELETE", { path: "/mcp/fixture" })
        check(again.status === 404, "removed dynamic MCP server must no longer resolve")
      }),
    ),
]
