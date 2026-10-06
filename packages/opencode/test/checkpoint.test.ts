import { $ } from "bun"
import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import path from "path"
import { Checkpoint } from "@/checkpoint"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { TestInstance } from "./fixture/fixture"
import { pollWithTimeout, testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Checkpoint.node,
      Database.node,
      FSUtil.node,
      Snapshot.node,
      Storage.node,
      Session.node,
      SessionRevert.node,
      SessionRunState.node,
      SessionProjector.node,
      LayerNodePlatform.filesystem,
    ]),
  ),
)

function requireSnapshot(value: string | undefined) {
  return value === undefined ? Effect.die(new Error("snapshot was not created")) : Effect.succeed(value)
}

function git(cwd: string, ...args: string[]) {
  return Effect.promise(async () => (await $`git ${args}`.cwd(cwd).quiet().nothrow().text()).trim())
}

function cleanupCheckpoint(projectID: ProjectV2.ID, worktree: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* fs
      .remove(path.join(Global.Path.data, "storage", "checkpoint", projectID))
      .pipe(Effect.catch(() => Effect.void))
    yield* fs
      .remove(path.join(Global.Path.data, "checkpoint", projectID, Hash.fast(worktree)))
      .pipe(Effect.catch(() => Effect.void))
  })
}

describe("Checkpoint", () => {
  it.instance(
    "captures database-only and memory-only changes with an unchanged Git tree",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const fs = yield* FSUtil.Service
        const snapshot = yield* Snapshot.Service
        const checkpoint = yield* Checkpoint.Service
        const database = yield* Database.Service
        const sessionID = SessionID.create()
        const messageID = MessageID.ascending()
        yield* Effect.addFinalizer(() => cleanupCheckpoint(context.project.id, context.worktree))
        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: context.project.id,
            slug: sessionID,
            directory: instance.directory,
            title: "unchanged-tree",
            version: "test",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionContextEpochTable)
          .values({
            session_id: sessionID,
            baseline: "before",
            snapshot: { "test/context": { value: "before" } },
            baseline_seq: 0,
          })
          .pipe(Effect.orDie)
        yield* fs.writeWithDirs(path.join(instance.directory, ".gitignore"), "*.sqlite\n")
        yield* fs.writeWithDirs(path.join(instance.directory, "app.sqlite"), "database-v1")
        const hash = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const first = yield* checkpoint.create({ from: hash, hash, sessionID, messageID })
        if (!first) throw new Error("first checkpoint was not created")

        yield* fs.writeWithDirs(path.join(instance.directory, "app.sqlite"), "database-v2")
        expect(yield* snapshot.track()).toBe(hash)
        const second = yield* checkpoint.create({ from: hash, hash, sessionID, messageID })
        if (!second) throw new Error("database-only checkpoint was not created")
        expect(second.id).not.toBe(first.id)
        expect(second.parentID).toBe(first.id)
        expect(second.files).toEqual([])
        expect(second.database[0]?.hash).toBe(Hash.sha256("database-v2"))

        const after = { "test/context": { value: "after" } }
        yield* database.db
          .update(SessionContextEpochTable)
          .set({ snapshot: after })
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .pipe(Effect.orDie)
        const third = yield* checkpoint.create({ from: hash, hash, sessionID, messageID })
        if (!third) throw new Error("memory-only checkpoint was not created")
        expect(third.id).not.toBe(second.id)
        expect(third.parentID).toBe(second.id)
        expect(third.files).toEqual([])
        expect(third.memory).toEqual([{ sessionID, exists: true, snapshot: after }])
        expect((yield* checkpoint.create({ from: hash, hash, sessionID, messageID }))?.id).toBe(third.id)
        expect((yield* checkpoint.list(context.project.id)).length).toBe(3)
        yield* fs.writeWithDirs(path.join(instance.directory, "app.sqlite"), "database-v3")
        yield* database.db
          .update(SessionContextEpochTable)
          .set({ snapshot: {} })
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .pipe(Effect.orDie)
        yield* checkpoint.rollback({ projectID: context.project.id, checkpointID: third.id })
        expect(yield* fs.readFileString(path.join(instance.directory, "app.sqlite"))).toBe("database-v2")
        expect(
          yield* database.db
            .select({ snapshot: SessionContextEpochTable.snapshot })
            .from(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, sessionID))
            .pipe(Database.first, Effect.orDie),
        ).toEqual({ snapshot: after })
      }),
    { git: true },
  )

  for (const damage of ["missing", "hash", "size", "path", "duplicate", "symlink", "memory", "snapshot"] as const) {
    it.instance(
      `rejects ${damage} database artifacts before changing conversation or files`,
      () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const context = yield* InstanceState.context
          const fs = yield* FSUtil.Service
          const snapshot = yield* Snapshot.Service
          const checkpoint = yield* Checkpoint.Service
          const storage = yield* Storage.Service
          const database = yield* Database.Service
          const sessions = yield* Session.Service
          const sessionID = SessionID.create()
          const firstID = MessageID.ascending()
          const laterID = MessageID.ascending()
          yield* Effect.addFinalizer(() => cleanupCheckpoint(context.project.id, context.worktree))
          yield* database.db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: context.project.id,
              slug: sessionID,
              directory: instance.directory,
              title: "invalid-artifact",
              version: "test",
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .pipe(Effect.orDie)
          for (const id of [firstID, laterID]) {
            yield* sessions.updateMessage({
              id,
              sessionID,
              role: "user",
              agent: "build",
              time: { created: Date.now() },
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            })
            yield* sessions.updatePart({
              type: "text",
              id: PartID.ascending(),
              messageID: id,
              sessionID,
              text: "hello",
            })
          }
          yield* fs.writeWithDirs(path.join(instance.directory, "tracked.txt"), "before")
          yield* fs.writeWithDirs(path.join(instance.directory, "app.sqlite"), "database-v1")
          const hash = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
          const created = yield* checkpoint.create({ from: hash, hash, sessionID, messageID: firstID })
          if (!created) throw new Error("checkpoint was not created")
          const filename = path.join(
            Global.Path.data,
            "checkpoint",
            context.project.id,
            Hash.fast(context.worktree),
            created.id,
            "database",
            "app.sqlite",
          )
          const artifact = created.database[0]!
          if (damage === "missing") yield* fs.remove(filename)
          if (damage === "hash") yield* fs.writeFile(filename, new TextEncoder().encode("database-v0"))
          if (damage === "size") yield* fs.writeFile(filename, new TextEncoder().encode("truncated"))
          if (damage === "symlink") {
            yield* fs.rename(filename, filename + ".original")
            yield* fs.symlink(filename + ".original", filename)
          }
          if (damage === "path" || damage === "duplicate") {
            yield* storage.write(["checkpoint", context.project.id, created.id], {
              ...created,
              database: damage === "path" ? [{ ...artifact, path: "../escape.sqlite" }] : [artifact, artifact],
            })
          }
          if (damage === "memory") {
            yield* storage.write(["checkpoint", context.project.id, created.id], { ...created, memory: null })
          }
          if (damage === "snapshot") {
            yield* storage.write(["checkpoint", context.project.id, created.id], {
              ...created,
              snapshotHash: "0".repeat(40),
            })
          }
          yield* fs.writeWithDirs(path.join(instance.directory, "tracked.txt"), "later code")
          yield* fs.writeWithDirs(path.join(instance.directory, "app.sqlite"), "database-v2")
          yield* fs.writeWithDirs(path.join(instance.directory, "later.sqlite"), "later database")

          expect(
            yield* checkpoint
              .rollback({ projectID: context.project.id, checkpointID: created.id })
              .pipe(Effect.isFailure),
          ).toBe(true)
          expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
          expect(yield* fs.readFileString(path.join(instance.directory, "tracked.txt"))).toBe("later code")
          expect(yield* fs.readFileString(path.join(instance.directory, "app.sqlite"))).toBe("database-v2")
          expect(yield* fs.readFileString(path.join(instance.directory, "later.sqlite"))).toBe("later database")
        }),
      { git: true },
    )
  }

  it.instance(
    "captures, lists, diffs, and rolls back project files",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const fs = yield* FSUtil.Service
        const snapshot = yield* Snapshot.Service
        const checkpoint = yield* Checkpoint.Service
        const sessionID = SessionID.create()
        const messageID = MessageID.ascending()
        yield* Effect.addFinalizer(() => cleanupCheckpoint(context.project.id, context.worktree))

        const head = yield* git(instance.directory, "rev-parse", "HEAD")
        const ref = `refs/omai/checkpoints/${Hash.fast(context.worktree)}`
        const from = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        yield* fs.writeWithDirs(path.join(instance.directory, "tracked.txt"), "after")
        const hash = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const created = yield* checkpoint.create({ from, hash, sessionID, messageID, title: "Capture tracked file" })
        if (!created) throw new Error("checkpoint was not created")
        expect(created.files).toEqual(["tracked.txt"])
        expect(created.additions).toBe(1)
        if (!created.commit) throw new Error("checkpoint commit was not published")
        expect(yield* git(instance.directory, "rev-parse", "--verify", ref)).toBe(created.commit)
        expect(yield* git(instance.directory, "log", "-1", "--format=%s", created.commit)).toBe("Capture tracked file")
        expect(
          yield* git(instance.directory, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", created.commit),
        ).toBe("tracked.txt")
        expect(yield* git(instance.directory, "rev-parse", "HEAD")).toBe(head)
        expect(yield* git(instance.directory, "diff", "--cached", "--name-only")).toBe("")
        expect((yield* checkpoint.list(context.project.id)).map((item) => item.id)).toEqual([created.id])
        expect(
          (yield* checkpoint.diff({ projectID: context.project.id, checkpointID: created.id })).files.map(
            (item) => item.file,
          ),
        ).toEqual([...created.files])

        yield* fs.writeWithDirs(path.join(instance.directory, "tracked.txt"), "later")
        yield* fs.writeWithDirs(path.join(instance.directory, "extra.txt"), "extra")
        const secondHash = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const second = yield* checkpoint.create({ from: hash, hash: secondHash, sessionID, messageID })
        if (!second) throw new Error("second checkpoint was not created")
        expect(second.files.toSorted()).toEqual(["extra.txt", "tracked.txt"])
        if (!second.commit) throw new Error("second checkpoint commit was not published")
        expect(yield* git(instance.directory, "rev-parse", `${second.commit}^`)).toBe(created.commit)
        expect(yield* git(instance.directory, "rev-parse", "--verify", ref)).toBe(second.commit)
        expect(
          (yield* git(instance.directory, "diff-tree", "--no-commit-id", "--name-only", "-r", second.commit))
            .split("\n")
            .toSorted(),
        ).toEqual(["extra.txt", "tracked.txt"])
        expect(yield* git(instance.directory, "log", "--format=%s", ref)).toBe("Checkpoint\nCapture tracked file")
        expect(yield* git(instance.directory, "rev-parse", "HEAD")).toBe(head)
        expect(yield* git(instance.directory, "diff", "--cached", "--name-only")).toBe("")

        yield* checkpoint.rollback({ projectID: context.project.id, checkpointID: created.id })
        expect(yield* fs.readFileString(path.join(instance.directory, "tracked.txt"))).toBe("after")
        expect(yield* fs.existsSafe(path.join(instance.directory, "extra.txt"))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "restores deleted database artifacts and removes later database files",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const fs = yield* FSUtil.Service
        const snapshot = yield* Snapshot.Service
        const checkpoint = yield* Checkpoint.Service
        const sessionID = SessionID.create()
        const messageID = MessageID.ascending()
        yield* Effect.addFinalizer(() => cleanupCheckpoint(context.project.id, context.worktree))

        const databasePath = path.join(instance.directory, "app.sqlite")
        yield* fs.writeWithDirs(path.join(instance.directory, "tracked.txt"), "initial")
        yield* fs.writeWithDirs(databasePath, "database-v1")
        const from = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const firstHash = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const first = yield* checkpoint.create({ from, hash: firstHash, sessionID, messageID })
        if (!first) throw new Error("first checkpoint was not created")
        expect(first.commit).toBeUndefined()

        yield* fs.remove(databasePath)
        const secondHash = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const second = yield* checkpoint.create({ from: firstHash, hash: secondHash, sessionID, messageID })
        if (!second) throw new Error("second checkpoint was not created")
        expect(second.database).toEqual([{ path: "app.sqlite", exists: false }])
        expect(second.files).toEqual(["app.sqlite"])
        if (!second.commit) throw new Error("second checkpoint commit was not published")
        expect(
          yield* git(instance.directory, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", second.commit),
        ).toBe("tracked.txt")
        expect(
          yield* git(
            instance.directory,
            "rev-parse",
            "--verify",
            `refs/omai/checkpoints/${Hash.fast(context.worktree)}`,
          ),
        ).toBe(second.commit)

        yield* fs.writeWithDirs(databasePath, "database-v2")
        yield* fs.writeWithDirs(path.join(instance.directory, "later.sqlite"), "later")
        yield* checkpoint.rollback({ projectID: context.project.id, checkpointID: first.id })
        expect(yield* fs.readFileString(databasePath)).toBe("database-v1")
        expect(yield* fs.existsSafe(path.join(instance.directory, "later.sqlite"))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "rolls back a code-only checkpoint with its own unchanged database artifacts",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const fs = yield* FSUtil.Service
        const snapshot = yield* Snapshot.Service
        const checkpoint = yield* Checkpoint.Service
        const sessionID = SessionID.create()
        const messageID = MessageID.ascending()
        yield* Effect.addFinalizer(() => cleanupCheckpoint(context.project.id, context.worktree))

        const databasePath = path.join(instance.directory, "app.sqlite")
        const databaseBytes = new Uint8Array([83, 81, 76, 105, 116, 101, 0, 255, 127])
        const codePath = path.join(instance.directory, "tracked.txt")
        yield* fs.writeWithDirs(codePath, "initial code")
        yield* fs.writeWithDirs(databasePath, databaseBytes)
        const initial = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const first = yield* checkpoint.create({ from: initial, hash: initial, sessionID, messageID })
        if (!first) throw new Error("initial database checkpoint was not created")

        yield* fs.writeWithDirs(codePath, "code-only change")
        const codeOnlyHash = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const codeOnly = yield* checkpoint.create({ from: initial, hash: codeOnlyHash, sessionID, messageID })
        if (!codeOnly) throw new Error("code-only checkpoint was not created")
        expect(codeOnly.id).not.toBe(first.id)
        expect(codeOnly.parentID).toBe(first.id)
        expect(codeOnly.files).toEqual(["tracked.txt"])
        expect(codeOnly.database).toEqual(first.database)

        // A new checkpoint must restore independently of its ancestor's artifact directory.
        yield* fs.remove(
          path.join(Global.Path.data, "checkpoint", context.project.id, Hash.fast(context.worktree), first.id),
          { recursive: true },
        )
        yield* fs.writeWithDirs(databasePath, "later database contents")
        yield* fs.writeWithDirs(codePath, "later code")
        yield* fs.writeWithDirs(path.join(instance.directory, "later.sqlite"), "later database")
        yield* checkpoint.rollback({ projectID: context.project.id, checkpointID: codeOnly.id })
        expect(yield* fs.readFile(databasePath)).toEqual(databaseBytes)
        expect(yield* fs.readFileString(codePath)).toBe("code-only change")
        expect(yield* fs.existsSafe(path.join(instance.directory, "later.sqlite"))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "restores context epoch memory and removes later session epochs",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const fs = yield* FSUtil.Service
        const snapshot = yield* Snapshot.Service
        const checkpoint = yield* Checkpoint.Service
        const database = yield* Database.Service
        const sessionID = SessionID.create()
        const extraSessionID = SessionID.create()
        const messageID = MessageID.ascending()
        const before = { "test/context": { value: "before" } }
        yield* Effect.addFinalizer(() => cleanupCheckpoint(context.project.id, context.worktree))

        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: context.project.id,
            slug: sessionID,
            directory: instance.directory,
            title: "checkpoint-memory",
            version: "0.0.0-test",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionContextEpochTable)
          .values({ session_id: sessionID, baseline: "before", snapshot: before, baseline_seq: 0 })
          .pipe(Effect.orDie)

        const from = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        yield* fs.writeWithDirs(path.join(instance.directory, "memory.txt"), "after")
        const hash = yield* snapshot.track().pipe(Effect.flatMap(requireSnapshot))
        const created = yield* checkpoint.create({ from, hash, sessionID, messageID })
        if (!created) throw new Error("memory checkpoint was not created")
        expect(created.memory).toEqual([{ sessionID, exists: true, snapshot: before }])

        yield* database.db
          .update(SessionContextEpochTable)
          .set({ snapshot: { "test/context": { value: "after" } } })
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values({
            id: extraSessionID,
            project_id: context.project.id,
            slug: extraSessionID,
            directory: instance.directory,
            title: "later-memory",
            version: "0.0.0-test",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionContextEpochTable)
          .values({ session_id: extraSessionID, baseline: "later", snapshot: {}, baseline_seq: 0 })
          .pipe(Effect.orDie)

        yield* checkpoint.rollback({ projectID: context.project.id, checkpointID: created.id })
        expect(
          yield* database.db
            .select()
            .from(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, sessionID))
            .pipe(Database.first)
            .pipe(Effect.orDie),
        ).toMatchObject({ snapshot: before })
        expect(
          yield* database.db
            .select()
            .from(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, extraSessionID))
            .pipe(Database.first)
            .pipe(Effect.orDie),
        ).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "reverts the conversation even when the session is busy",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const database = yield* Database.Service
        const sessions = yield* Session.Service
        const revert = yield* SessionRevert.Service
        const state = yield* SessionRunState.Service
        const sessionID = SessionID.create()
        yield* Effect.addFinalizer(() => cleanupCheckpoint(context.project.id, context.worktree))

        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: context.project.id,
            slug: sessionID,
            directory: instance.directory,
            title: "busy-revert",
            version: "0.0.0-test",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .pipe(Effect.orDie)

        const firstID = MessageID.ascending()
        const laterID = MessageID.ascending()
        const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
        for (const [id, created] of [
          [firstID, Date.now()],
          [laterID, Date.now() + 1],
        ] as const) {
          const message: SessionV1.User = {
            id,
            sessionID,
            time: { created },
            role: "user",
            agent: "build",
            model,
          }
          yield* sessions.updateMessage(message)
          yield* sessions.updatePart({
            type: "text",
            id: PartID.ascending(),
            messageID: id,
            sessionID,
            text: "hello",
            synthetic: true,
          })
        }

        yield* state
          .ensureRunning(
            sessionID,
            Effect.gen(function* () {
              const message = (yield* sessions.messages({ sessionID }).pipe(Effect.orDie)).at(-1)
              if (!message) return yield* Effect.die(new Error("no messages to return as onInterrupt"))
              return message
            }),
            Effect.never,
          )
          .pipe(Effect.forkScoped)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const isBusy = yield* state.assertNotBusy(sessionID).pipe(Effect.isFailure)
            return isBusy ? (true as const) : undefined
          }),
          "session never became busy",
        )

        const succeeded = yield* revert.revertAfter({ sessionID, messageID: firstID }).pipe(Effect.isSuccess)
        expect(succeeded).toBe(true)

        const messageID = yield* pollWithTimeout(
          Effect.gen(function* () {
            const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
            return info.revert?.messageID
          }),
          "revert boundary was never persisted",
        )
        expect(messageID).toBe(laterID)
        yield* state.assertNotBusy(sessionID)
      }),
    { git: true },
  )
})
