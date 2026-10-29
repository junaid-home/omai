import { Database } from "@opencode-ai/core/database/database"
import { ProjectThumbnailTable } from "@opencode-ai/core/project/thumbnail.sql"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"

// A MicroVM writes its screenshots to its own volume, which the control plane
// cannot read. Copying them into the shared database lets the project list
// show them, also while the VM is paused.

/** Copies the project's on-disk thumbnail, if any, into the shared database. */
export const persist = Effect.fn("ThumbnailStore.persist")(function* (directory: string) {
  const png = yield* Effect.promise(() =>
    readFile(path.join(directory, ".OMAI+", "thumbnails", "preview.png")).catch(() => undefined),
  )
  if (!png) return
  const { db } = yield* Database.Service
  const now = Date.now()
  const data = png.toString("base64")
  yield* db
    .insert(ProjectThumbnailTable)
    .values({ directory, png: data, time_created: now, time_updated: now })
    .onConflictDoUpdate({ target: ProjectThumbnailTable.directory, set: { png: data, time_updated: now } })
    .pipe(Effect.orDie)
})

export const read = Effect.fn("ThumbnailStore.read")(function* (directory: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ png: ProjectThumbnailTable.png })
    .from(ProjectThumbnailTable)
    .where(eq(ProjectThumbnailTable.directory, directory))
    .pipe(Database.first)
    .pipe(Effect.orDie)
  return row ? Buffer.from(row.png, "base64") : undefined
})

export * as ThumbnailStore from "./thumbnail-store"
