import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export class SnapshotError extends Error {
  readonly _tag = "StaticPreview.SnapshotError"
  constructor(
    readonly status: 403 | 413 | 429 | 503,
    message: string,
  ) {
    super(message)
  }
}

export const maxSnapshots = 128
export const maxBytes = 8 * 1024 * 1024
// Authentication sessions last at most 12 hours. A 24-hour-old snapshot cannot
// have a live capability, so cleanup never invalidates an active preview.
export const retentionMs = 24 * 60 * 60 * 1000
const writes = Semaphore.makeUnsafe(1)

export const write = Effect.fn("StaticPreview.write")((directory: string, html: string) =>
  Effect.tryPromise({
    try: async () => {
      if (Buffer.byteLength(html) > maxBytes) throw new SnapshotError(413, "Preview HTML exceeds 8 MiB")
      const root = await CentralStorage.resolveWorkspace(path.join(directory, ".OMAI+", "preview"))
      await mkdir(root, { recursive: true })
      const entries = await readdir(root, { withFileTypes: true })
      let active = 0
      for (const entry of entries) {
        if (!/^[a-f0-9-]{36}\.html$/.test(entry.name)) continue
        const file = path.join(root, entry.name)
        const info = await lstat(file)
        if (!info.isFile() || info.isSymbolicLink()) throw new SnapshotError(503, "Preview snapshot storage is invalid")
        if (info.mtimeMs + retentionMs < Date.now()) await rm(file)
        else active++
      }
      if (active >= maxSnapshots)
        throw new SnapshotError(429, "Preview snapshot quota reached; retry after existing snapshots expire")
      const id = randomUUID()
      const file = await CentralStorage.resolveWorkspace(path.join(root, `${id}.html`))
      await writeFile(file, html, { flag: "wx", mode: 0o600 })
      return { id, file }
    },
    catch: (cause) =>
      cause instanceof SnapshotError ? cause : new SnapshotError(503, "Preview snapshot storage is unavailable"),
  }).pipe(writes.withPermit),
)

export * as StaticPreview from "./static"
