import { Effect } from "effect"
import { rm } from "node:fs/promises"
import path from "node:path"
import { array, check, object } from "./assertions"
import { http } from "./dsl"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
)
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const encoded = (directory: string) => Buffer.from(directory).toString("base64url")

export const fileScenarios = [
  http.protected
    .post("/file/write", "omai.file.write")
    .at((ctx) => ({
      path: "/file/write",
      headers: ctx.headers(),
      body: { directory: ctx.directory, path: "nested/file.txt", content: "Written through HTTP\n" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "write should succeed")
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "nested/file.txt")).text())) ===
            "Written through HTTP\n",
          "write must persist exact bytes",
        )
      }),
    ),
  http.protected
    .post("/file/remove", "omai.file.remove")
    .seeded((ctx) => ctx.file("delete-me.txt", "delete me"))
    .at((ctx) => ({
      path: "/file/remove",
      headers: ctx.headers(),
      body: { directory: ctx.directory, path: "delete-me.txt" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "remove should succeed")
        check(
          !(yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "delete-me.txt")).exists())),
          "remove must delete the requested file",
        )
      }),
    ),
  http.protected
    .post("/file/rename", "omai.file.rename")
    .seeded((ctx) => ctx.file("old.txt", "preserved content"))
    .at((ctx) => ({
      path: "/file/rename",
      headers: ctx.headers(),
      body: { directory: ctx.directory, oldPath: "old.txt", newPath: "nested/new.txt" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "rename should succeed")
        check(
          !(yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "old.txt")).exists())),
          "old path must disappear",
        )
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "nested/new.txt")).text())) ===
            "preserved content",
          "renamed file must preserve bytes",
        )
      }),
    ),
  http.protected
    .post("/file/upload", "omai.file.upload")
    .at((ctx) => ({
      path: "/file/upload",
      headers: ctx.headers(),
      body: { fileName: "image.png", content: png.toString("base64") },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true && body.path === "image.png", "upload should return the stored relative path")
        const data = yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "image.png")).arrayBuffer())
        check(Buffer.from(data).equals(png), "uploaded image must retain exact binary bytes")
      }),
    ),
  http.protected
    .post("/file/download", "omai.file.download")
    .seeded((ctx) =>
      Effect.gen(function* () {
        yield* ctx.file("src/example.ts", "export const answer = 42\n")
        yield* ctx.file("bin/start.sh", "#!/bin/sh\nexit 0\n")
      }),
    )
    .at((ctx) => ({ path: "/file/download", headers: ctx.headers(), body: { directory: ctx.directory } }))
    .status(200, (ctx, result) =>
      Effect.promise(async () => {
        check(result.contentType.includes("application/zip"), "download should return a ZIP")
        const { default: JSZip } = await import("jszip")
        const zip = await JSZip.loadAsync(result.bytes, { checkCRC32: true })
        const root = path.basename(ctx.directory!)
        check(
          (await zip.file(`${root}/src/example.ts`)?.async("string")) === "export const answer = 42\n",
          "download must preserve source content",
        )
        check(
          (await zip.file(`${root}/bin/start.sh`)?.async("string")) === "#!/bin/sh\nexit 0\n",
          "download must retain source bin directories",
        )
        check(
          !Object.keys(zip.files).some((name) => name.includes("/.git/")),
          "download must exclude repository internals",
        )
      }),
    ),
  http.protected
    .post("/file/visual-edit", "omai.file.visualEdit.noProvider")
    .inProject({ git: true, config: { enabled_providers: [] } })
    .seeded((ctx) => ctx.file("index.html", "<h1>Unchanged</h1>"))
    .at((ctx) => ({
      path: "/file/visual-edit",
      headers: ctx.headers(),
      body: {
        modifiedHtml: "<h1>Changed</h1>",
        changes: [{ selector: "h1", type: "text", content: "Changed", sourcePath: "index.html" }],
      },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        array(body.filesWritten)
        check(
          body.success === false && body.filesWritten.length === 0,
          "missing model must be an explicit unsuccessful edit",
        )
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.directory!, "index.html")).text())) ===
            "<h1>Unchanged</h1>",
          "failed edit must preserve the source",
        )
      }),
    ),
  http.protected
    .get("/file/image", "omai.media.image")
    .seeded((ctx) => Effect.promise(() => Bun.write(path.join(ctx.directory!, "image.png"), png)))
    .at((ctx) => ({
      path: `/file/image?${new URLSearchParams({ path: path.join(ctx.directory!, "image.png") })}`,
      headers: ctx.headers(),
    }))
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(
          result.contentType.includes("image/png") && Buffer.from(result.bytes).equals(png),
          "image route must stream exact fixture bytes",
        )
        check(result.headers.get("x-content-type-options") === "nosniff", "image route must prevent content sniffing")
      }),
    ),
  http.protected
    .get("/file/video", "omai.media.video")
    .seeded((ctx) => ctx.file("clip.mp4", "bounded fixture video bytes"))
    .at((ctx) => ({
      path: `/file/video?${new URLSearchParams({ path: path.join(ctx.directory!, "clip.mp4") })}`,
      headers: ctx.headers(),
    }))
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(
          result.contentType.includes("video/mp4") && result.text === "bounded fixture video bytes",
          "video route must stream requested file bytes",
        )
        check(result.headers.get("cache-control")?.includes("no-store") === true, "private video must not be cached")
      }),
    ),
  http.protected
    .get("/preview/thumbnail/{encodedDir}", "omai.media.thumbnail.get")
    .seeded((ctx) => Effect.promise(() => Bun.write(path.join(ctx.directory!, ".OMAI+/thumbnails/preview.png"), png)))
    .at((ctx) => ({ path: `/preview/thumbnail/${encoded(ctx.directory!)}`, headers: ctx.headers() }))
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(
          result.contentType.includes("image/png") && Buffer.from(result.bytes).equals(png),
          "thumbnail must resolve the encoded workspace and stream exact bytes",
        )
      }),
    ),
  http.protected
    .get("/preview/thumbnail/{encodedDir}", "omai.media.thumbnail.get.database")
    // A MicroVM project's file lives on the VM; only the database copy is
    // reachable from the server answering the project list.
    .seeded((ctx) =>
      Effect.gen(function* () {
        const saved = yield* ctx.request("POST", {
          path: `/preview/thumbnail/${encoded(ctx.directory!)}`,
          headers: ctx.headers(),
          body: { png: png.toString("base64") },
        })
        check(saved.status === 200, "thumbnail fixture must be stored through HTTP")
        yield* Effect.promise(() => rm(path.join(ctx.directory!, ".OMAI+/thumbnails/preview.png")))
      }),
    )
    .at((ctx) => ({ path: `/preview/thumbnail/${encoded(ctx.directory!)}`, headers: ctx.headers() }))
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(
          result.contentType.includes("image/png") && Buffer.from(result.bytes).equals(png),
          "thumbnail must fall back to the database copy when the file is not on this server",
        )
      }),
    ),
  http.protected
    .post("/preview/thumbnail/{encodedDir}", "omai.media.thumbnail.put")
    .at((ctx) => ({
      path: `/preview/thumbnail/${encoded(ctx.directory!)}`,
      headers: ctx.headers(),
      body: { png: png.toString("base64") },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "thumbnail write should succeed")
        const saved = yield* Effect.promise(() =>
          Bun.file(path.join(ctx.directory!, ".OMAI+/thumbnails/preview.png")).arrayBuffer(),
        )
        check(Buffer.from(saved).equals(png), "thumbnail write must preserve PNG bytes")
      }),
    ),
  http.protected
    .post("/preview/thumbnail/{encodedDir}/capture", "omai.media.thumbnail.capture")
    .seeded((ctx) =>
      Effect.promise(() =>
        Bun.write(
          path.join(ctx.directory!, ".OMAI+/preview", "3b25f0c1-8d3e-4a17-9f6b-1c2d3e4f5a6b.html"),
          '<!doctype html><meta charset="utf-8"><title>Capture</title>' +
            "<style>html,body{margin:0;background:#0f172a;color:#fff;font:40px/600px sans-serif;text-align:center}</style>" +
            "<body>OMAI +</body>",
        ),
      ),
    )
    .at((ctx) => ({ path: `/preview/thumbnail/${encoded(ctx.directory!)}/capture`, headers: ctx.headers() }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "thumbnail capture should succeed")
        const saved = yield* Effect.promise(() =>
          Bun.file(path.join(ctx.directory!, ".OMAI+/thumbnails/preview.png")).arrayBuffer(),
        )
        const data = Buffer.from(saved)
        check(data.subarray(0, 8).equals(pngSignature), "thumbnail capture must store a headless chromium screenshot")
        check(data.byteLength > 1024, "thumbnail capture must store a rendered page, not an empty file")
      }),
    ),
  http.protected
    .post("/preview/thumbnail/{encodedDir}/capture", "omai.media.thumbnail.capture.unavailable")
    .at((ctx) => ({ path: `/preview/thumbnail/${encoded(ctx.directory!)}/capture`, headers: ctx.headers() }))
    .json(409, (body) => {
      object(body)
      check(body.success === false, "capture without a preview must fail")
      check(typeof body.error === "string" && body.error.length > 0, "capture must explain why it failed")
    }),
]
