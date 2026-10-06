import { Storage } from "@google-cloud/storage"
import { AwsClient } from "aws4fetch"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"

export class UploadError extends Schema.TaggedErrorClass<UploadError>()("FileStorageUploadError", {
  status: Schema.Number,
  key: Schema.String,
}) {
  override get message() {
    return `Failed to upload "${this.key}" to object storage: ${this.status}`
  }
}

export class StorageNotConfiguredError extends Schema.TaggedErrorClass<StorageNotConfiguredError>()(
  "FileStorageNotConfiguredError",
  {},
) {
  override get message() {
    return "Object storage is not configured"
  }
}

export type Error = UploadError | StorageNotConfiguredError

const DATA_URL_RE = /^data:(.+?);base64,(.*)$/s

export interface Interface {
  // Uploads raw bytes to object storage and returns a public URL. Fails if
  // the upload fails.
  readonly put: (input: { mime: string; data: Uint8Array }) => Effect.Effect<string, Error>
  // If object storage is configured and `part.url` is an inline base64 data
  // URL, uploads the bytes and replaces the URL with a public object URL.
  // Never fails; on upload failure the part is returned unchanged.
  readonly store: (part: SessionV1.FilePart) => Effect.Effect<SessionV1.FilePart>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileStorage") {}

interface Adapter {
  readonly put: (key: string, mime: string, data: Uint8Array) => Promise<void>
}

function gcs(): Adapter | undefined {
  const bucket = process.env.OPENCODE_STORAGE_BUCKET
  if (!bucket) return undefined
  const client = new Storage()
  const base = `https://storage.googleapis.com/${bucket}`
  return {
    async put(key, mime, data) {
      await client.bucket(bucket).file(key).save(Buffer.from(data), {
        contentType: mime,
        resumable: false,
      })
    },
  }
}

function s3(): Adapter | undefined {
  const bucket = process.env.OPENCODE_STORAGE_BUCKET
  if (!bucket) return undefined
  const endpoint = process.env.OPENCODE_STORAGE_ENDPOINT
  if (!endpoint) return undefined
  const accessKeyId = process.env.OPENCODE_STORAGE_ACCESS_KEY_ID
  if (!accessKeyId) return undefined
  const secretAccessKey = process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY
  if (!secretAccessKey) return undefined
  const region = process.env.OPENCODE_STORAGE_REGION || "auto"

  const client = new AwsClient({
    region,
    accessKeyId,
    secretAccessKey,
    service: "s3",
  })

  return {
    async put(key, mime, data) {
      const url = `${endpoint}/${bucket}/${key}`
      const response = await client.fetch(url, {
        method: "PUT",
        body: new Uint8Array(data).buffer,
        headers: {
          "Content-Type": mime,
        },
      })
      if (!response.ok) {
        throw new Error(`S3 upload failed: ${response.status}`)
      }
    },
  }
}

function extension(mime: string): string {
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  }
  return known[mime] ?? "bin"
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const adapterType = process.env.OPENCODE_STORAGE_ADAPTER
    const adapter = adapterType === "s3" ? s3() : gcs()

    const put = (input: { mime: string; data: Uint8Array }) =>
      Effect.gen(function* () {
        if (!adapter) return yield* new StorageNotConfiguredError()
        const key = `omai/${Date.now()}-${randomUUID()}.${extension(input.mime)}`
        yield* Effect.tryPromise(() => adapter.put(key, input.mime, input.data)).pipe(
          Effect.catchCause(() => Effect.fail(new UploadError({ status: 0, key }))),
        )

        if (adapterType === "s3") {
          const endpoint = process.env.OPENCODE_STORAGE_ENDPOINT
          const bucket = process.env.OPENCODE_STORAGE_BUCKET
          return `${endpoint}/${bucket}/${key}`
        } else {
          return `https://storage.googleapis.com/${process.env.OPENCODE_STORAGE_BUCKET}/${key}`
        }
      })

    const store = (part: SessionV1.FilePart) =>
      Effect.gen(function* () {
        if (!adapter) return part
        const match = DATA_URL_RE.exec(part.url)
        if (!match) return part
        const bytes = new Uint8Array(Buffer.from(match[2], "base64"))
        const url = yield* put({ mime: match[1], data: bytes }).pipe(Effect.catchCause(() => Effect.succeed(part.url)))
        return { ...part, url }
      })

    return Service.of({ put, store })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as FileStorage from "./file-storage"
