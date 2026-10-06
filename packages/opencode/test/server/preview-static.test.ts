import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StaticPreview } from "../../src/preview/static"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
it.live("prunes expired snapshots and enforces quota across concurrent writes", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "omai-snapshot-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    )
    const directory = path.join(root, ".OMAI+", "preview")
    yield* Effect.promise(async () => {
      await mkdir(directory, { recursive: true })
      for (let index = 0; index < StaticPreview.maxSnapshots; index++)
        await writeFile(path.join(directory, `${crypto.randomUUID()}.html`), "preview")
      const [first] = await readdir(directory)
      const expired = new Date(Date.now() - StaticPreview.retentionMs - 1000)
      await utimes(path.join(directory, first), expired, expired)
    })
    const results = yield* Effect.all(
      [
        StaticPreview.write(root, "new preview").pipe(Effect.result),
        StaticPreview.write(root, "concurrent preview").pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    )
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
    expect(results.filter((result) => result._tag === "Failure" && result.failure.status === 429)).toHaveLength(1)
    expect((yield* Effect.promise(() => readdir(directory))).length).toBe(StaticPreview.maxSnapshots)
    const oversized = yield* StaticPreview.write(root, "x".repeat(StaticPreview.maxBytes + 1)).pipe(Effect.result)
    expect(oversized._tag === "Failure" && oversized.failure.status).toBe(413)
  }),
)
