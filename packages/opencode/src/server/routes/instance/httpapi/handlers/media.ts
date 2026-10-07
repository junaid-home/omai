import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { constants } from "node:fs"
import { open, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { decodeDirectory } from "@/preview/thumbnail"
import { capturePreview, MAX_CAPTURE_BYTES, PreviewUnavailableError } from "@/preview/capture"
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
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ThumbnailBody = Schema.Struct({ png: Schema.String })

async function writeThumbnail(target: string, data: Buffer) {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

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
  handlers
    .handleRaw("image", ({ request }) =>
      media(new URL(request.url, "http://localhost").searchParams.get("path") ?? "", images),
    )
    .handleRaw("video", ({ request }) =>
      media(new URL(request.url, "http://localhost").searchParams.get("path") ?? "", videos),
    )
    .handleRaw("thumbnailGet", ({ params }) => {
      const directory = decodeDirectory(params.encodedDir)
      return directory
        ? media(path.join(directory, ".OMAI+", "thumbnails", "preview.png"), images)
        : Effect.succeed(HttpServerResponse.empty({ status: 400 }))
    })
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
        return HttpServerResponse.jsonUnsafe({ success: true }, { headers: { "Cache-Control": "no-store" } })
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
    )
    .handleRaw("thumbnailCapture", ({ params }) =>
      Effect.gen(function* () {
        const directory = decodeDirectory(params.encodedDir)
        if (!directory) return json({ success: false, error: "Invalid directory" }, 400)
        const safe = yield* Effect.tryPromise({
          try: () => CentralStorage.resolveWorkspace(directory),
          catch: (cause) => cause,
        })
        const png = yield* Effect.tryPromise({ try: () => capturePreview(safe), catch: (cause) => cause })
        if (png.byteLength > MAX_CAPTURE_BYTES || !png.subarray(0, 8).equals(pngSignature))
          return json({ success: false, error: "The preview screenshot was invalid." }, 500)
        const target = yield* Effect.tryPromise(() =>
          CentralStorage.resolveWorkspace(path.join(safe, ".OMAI+", "thumbnails", "preview.png")),
        )
        yield* Effect.tryPromise(() => writeThumbnail(target, png))
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
    ),
)
