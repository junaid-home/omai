import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"
import { decodeDirectory } from "@/preview/thumbnail"
import { captureAndStoreThumbnail, pngSignature, PreviewUnavailableError, writeThumbnail } from "@/preview/capture"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { ThumbnailStore } from "@/preview/thumbnail-store"
import { RootHttpApi } from "../api"

const images: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  heic: "image/heic",
}
const videos: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  ogv: "video/ogg",
  mov: "video/quicktime",
  m4v: "video/mp4",
}
const ThumbnailBody = Schema.Struct({ png: Schema.String })

function json(body: Record<string, unknown>, status: number) {
  return HttpServerResponse.jsonUnsafe(body, { status, headers: { "Cache-Control": "no-store" } })
}

function media(input: string, contentTypes: Record<string, string>) {
  return Effect.gen(function* () {
    const canonical = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(input))
    const type = contentTypes[path.extname(canonical).slice(1).toLowerCase()]
    if (!type) return HttpServerResponse.empty({ status: 400 })
    const file = yield* Effect.acquireRelease(
      Effect.tryPromise(() => open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)),
      (handle) => Effect.promise(() => handle.close().catch(() => {})),
    )
    const info = yield* Effect.tryPromise(() => file.stat())
    if (!info.isFile()) return HttpServerResponse.empty({ status: 404 })
    return HttpServerResponse.stream(
      Stream.fromAsyncIterable(file.createReadStream({ autoClose: false }), (cause) => cause),
      {
        contentType: type,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
          "Content-Length": String(info.size),
        },
      },
    )
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
}

export const mediaHandlers = HttpApiBuilder.group(RootHttpApi, "media", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const client = yield* HttpClient.HttpClient

    // Only the control plane routes to VMs, and a paused VM is never woken
    // just to refresh a thumbnail.
    const vmFor = Effect.fnUntraced(function* (directory: string) {
      if (!Flag.OPENCODE_WORKSPACE_ADAPTER || Flag.OPENCODE_WORKSPACE_ID) return undefined
      const info = yield* workspace.getByDirectory(directory)
      if (!info) return undefined
      if (!(yield* workspace.isSynced(info.id))) return "asleep" as const
      const target = yield* WorkspaceAdapterRuntime.target(info).pipe(Effect.orElseSucceed(() => undefined))
      if (!target || target.type !== "remote") return "asleep" as const
      return { url: String(target.url), headers: target.headers }
    })

    return handlers
      .handleRaw("image", ({ request }) =>
        media(new URL(request.url, "http://localhost").searchParams.get("path") ?? "", images),
      )
      .handleRaw("video", ({ request }) =>
        media(new URL(request.url, "http://localhost").searchParams.get("path") ?? "", videos),
      )
      .handleRaw("thumbnailGet", ({ params }) =>
        Effect.gen(function* () {
          const directory = decodeDirectory(params.encodedDir)
          if (!directory) return HttpServerResponse.empty({ status: 400 })
          const local = yield* media(path.join(directory, ".OMAI+", "thumbnails", "preview.png"), images)
          if (local.status !== 404) return local
          // MicroVM projects: the file is on the VM, the copy is in the database.
          const png = yield* ThumbnailStore.read(directory)
          if (!png) return local
          return HttpServerResponse.uint8Array(png, {
            contentType: "image/png",
            headers: {
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "sandbox",
            },
          })
        }),
      )
      .handleRaw("thumbnailPut", ({ params, request }) =>
        Effect.gen(function* () {
          const directory = decodeDirectory(params.encodedDir)
          if (!directory) return HttpServerResponse.empty({ status: 400 })
          const text = yield* request.text.pipe(Effect.option)
          if (Option.isNone(text) || Buffer.byteLength(text.value) > 3 * 1024 * 1024)
            return HttpServerResponse.empty({ status: 413 })
          const body = Schema.decodeUnknownOption(Schema.fromJsonString(ThumbnailBody))(text.value)
          if (Option.isNone(body) || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.value.png))
            return HttpServerResponse.empty({ status: 400 })
          const data = Buffer.from(body.value.png, "base64")
          if (data.byteLength > 2 * 1024 * 1024) return HttpServerResponse.empty({ status: 413 })
          if (!data.subarray(0, 8).equals(pngSignature)) return HttpServerResponse.empty({ status: 400 })
          const target = yield* Effect.tryPromise(() =>
            CentralStorage.resolveWorkspace(path.join(directory, ".OMAI+", "thumbnails", "preview.png")),
          )
          yield* Effect.tryPromise(() => writeThumbnail(target, data))
          yield* ThumbnailStore.persist(directory)
          return HttpServerResponse.jsonUnsafe({ success: true }, { headers: { "Cache-Control": "no-store" } })
        }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
      )
      .handleRaw("thumbnailCapture", ({ params }) =>
        Effect.gen(function* () {
          const directory = decodeDirectory(params.encodedDir)
          if (!directory) return json({ success: false, error: "Invalid directory" }, 400)
          // The dev server of a MicroVM project runs on its VM: capture there.
          const vm = yield* vmFor(directory)
          if (vm === "asleep") return json({ success: true, skipped: true }, 200)
          if (vm) {
            const response = yield* client.execute(
              HttpClientRequest.post(`${vm.url.replace(/\/+$/, "")}/preview/thumbnail/${params.encodedDir}/capture`, {
                headers: new Headers(vm.headers),
              }),
            )
            const body = yield* response.json.pipe(Effect.orElseSucceed(() => ({})))
            return json(body as Record<string, unknown>, response.status)
          }
          const safe = yield* Effect.tryPromise({
            try: () => CentralStorage.resolveWorkspace(directory),
            catch: (cause) => cause,
          })
          const stored = yield* Effect.tryPromise({
            try: () => captureAndStoreThumbnail(safe),
            catch: (cause) => cause,
          })
          yield* ThumbnailStore.persist(safe)
          if (stored === "skipped") return json({ success: true, skipped: true }, 200)
          return HttpServerResponse.jsonUnsafe({ success: true }, { headers: { "Cache-Control": "no-store" } })
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              error instanceof PreviewUnavailableError
                ? json({ success: false, error: error.message }, 409)
                : json({ success: false, error: "Thumbnail capture failed." }, 500),
            ),
          ),
        ),
      )
  }),
)
