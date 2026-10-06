import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AppProcess } from "@opencode-ai/core/process"
import { ProjectV2 } from "@opencode-ai/core/project"
import { statics } from "@opencode-ai/core/schema"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
import { CentralStorage } from "@opencode-ai/core/storage/central"
import { SystemContext } from "@opencode-ai/core/system-context"
import { Hash } from "@opencode-ai/core/util/hash"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { MessageID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"

export const ID = Schema.String.check(Schema.isStartsWith("chk")).pipe(
  Schema.brand("Checkpoint.ID"),
  statics((id) => ({ ascending: () => id.make(Identifier.create("chk", "ascending")) })),
)
export type ID = typeof ID.Type

export const Artifact = Schema.Struct({
  path: Schema.String,
  exists: Schema.Boolean,
  size: Schema.optional(Schema.Number),
  hash: Schema.optional(Schema.String),
})
export type Artifact = typeof Artifact.Type

export const Memory = Schema.Struct({
  sessionID: SessionID,
  exists: Schema.Boolean,
  snapshot: Schema.optional(SystemContext.Snapshot),
})
export type Memory = typeof Memory.Type

export const Info = Schema.Struct({
  id: ID,
  parentID: Schema.optional(ID),
  projectID: ProjectV2.ID,
  worktree: Schema.String,
  snapshotHash: Schema.String,
  parentHash: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  sessionID: SessionID,
  messageID: MessageID,
  title: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  database: Schema.Array(Artifact),
  memory: Schema.Array(Memory),
  time: Schema.Struct({ created: Schema.Number }),
})
export type Info = typeof Info.Type

export const Summary = Schema.Struct({
  id: ID,
  parentID: Schema.optional(ID),
  projectID: ProjectV2.ID,
  sessionID: SessionID,
  messageID: MessageID,
  title: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  database: Schema.Boolean,
  memory: Schema.Boolean,
  time: Schema.Struct({ created: Schema.Number }),
})
export type Summary = typeof Summary.Type

export const Diff = Schema.Struct({
  checkpoint: ID,
  files: Schema.Array(Snapshot.FileDiff),
})
export type Diff = typeof Diff.Type

export function summarize(value: Info): Summary {
  return {
    id: value.id,
    parentID: value.parentID,
    projectID: value.projectID,
    sessionID: value.sessionID,
    messageID: value.messageID,
    title: value.title,
    files: value.files,
    additions: value.additions,
    deletions: value.deletions,
    database: value.database.length > 0,
    memory: value.memory.length > 0,
    time: value.time,
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Checkpoint.NotFoundError", {
  projectID: Schema.String,
  checkpointID: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

export interface CreateInput {
  readonly from: string
  readonly hash: string
  readonly sessionID: SessionID
  readonly messageID: MessageID
  readonly title?: string
}

export interface SelectInput {
  readonly projectID: ProjectV2.ID
  readonly checkpointID: ID
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info | undefined, Storage.Error>
  readonly list: (projectID: ProjectV2.ID) => Effect.Effect<ReadonlyArray<Info>, Storage.Error | NotFoundError>
  readonly diff: (input: SelectInput) => Effect.Effect<Diff, Storage.Error | NotFoundError>
  readonly rollback: (input: SelectInput) => Effect.Effect<Info, Storage.Error | NotFoundError | Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Checkpoint") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const storage = yield* Storage.Service
    const snapshot = yield* Snapshot.Service
    const database = yield* Database.Service
    const appProcess = yield* AppProcess.Service
    const revert = yield* SessionRevert.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const existing = locks.get(key)
      if (existing) return existing
      const created = Semaphore.makeUnsafe(1)
      locks.set(key, created)
      return created
    }

    const excluded = new Set([
      ".git",
      ".next",
      ".turbo",
      ".venv",
      "__pycache__",
      "build",
      "coverage",
      "dist",
      "node_modules",
      "target",
      "vendor",
      "venv",
    ])

    const discoverDatabase = Effect.fnUntraced(function* (worktree: string) {
      const files = yield* Effect.all(
        ["**/*.db", "**/*.sqlite", "**/*.sqlite3", "**/*-wal", "**/*-shm"].map((pattern) =>
          fs.glob(pattern, { cwd: worktree, absolute: true, include: "file", dot: true }),
        ),
        { concurrency: 5 },
      ).pipe(Effect.catch(() => Effect.succeed<string[][]>([])))
      return new Set(
        files.flat().flatMap((file) => {
          const relative = path.relative(worktree, file).replaceAll("\\", "/")
          if (!relative || relative.startsWith("../") || relative.split("/").some((item) => excluded.has(item)))
            return []
          return [relative]
        }),
      )
    })

    const inspectDatabase = Effect.fn("Checkpoint.inspectDatabase")(function* (worktree: string) {
      const current = yield* discoverDatabase(worktree)
      return yield* Effect.forEach(
        Array.from(current).toSorted(),
        (relative) =>
          Effect.gen(function* () {
            const content = yield* fs.readFile(path.join(worktree, relative))
            return {
              artifact: {
                path: relative,
                exists: true,
                size: content.byteLength,
                hash: Hash.sha256(Buffer.from(content)),
              } satisfies Artifact,
              content,
            }
          }),
        { concurrency: 4 },
      )
    })

    const persistDatabase = Effect.fnUntraced(function* (
      projectID: ProjectV2.ID,
      worktree: string,
      checkpointID: ID,
      values: ReadonlyArray<{ readonly artifact: Artifact; readonly content: Uint8Array }>,
    ) {
      yield* Effect.forEach(
        values,
        ({ artifact, content }) =>
          fs.writeWithDirs(artifactPath(projectID, worktree, checkpointID, artifact.path), content),
        { concurrency: 4 },
      )
    })

    const requireContext = Effect.fn("Checkpoint.requireContext")(function* (projectID: ProjectV2.ID) {
      const context = yield* InstanceState.context
      if (context.project.id !== projectID) {
        return yield* new NotFoundError({
          projectID,
          message: `Checkpoint project not found: ${projectID}`,
        })
      }
      return context
    })

    const load = Effect.fn("Checkpoint.load")(function* (projectID: ProjectV2.ID) {
      const keys = yield* storage.list(["checkpoint", projectID])
      return (yield* Effect.all(
        keys.map((key) => storage.read<Info>(key)),
        { concurrency: 8 },
      )).toSorted((a, b) => b.time.created - a.time.created || b.id.localeCompare(a.id))
    })

    const list = Effect.fn("Checkpoint.list")(function* (projectID: ProjectV2.ID) {
      const context = yield* requireContext(projectID)
      return (yield* load(projectID)).filter((item) => item.worktree === context.worktree)
    })

    const get = Effect.fn("Checkpoint.get")(function* (input: SelectInput) {
      const context = yield* requireContext(input.projectID)
      const key = ["checkpoint", input.projectID, input.checkpointID]
      const value = yield* storage.read<unknown>(key).pipe(
        Effect.catchTag("NotFoundError", () => new NotFoundError({ ...input, message: "Checkpoint not found" })),
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(Info)(value).pipe(
            Effect.mapError((cause) => new FSUtil.FileSystemError({ method: "Checkpoint.decode", cause })),
          ),
        ),
      )
      if (
        value.worktree !== context.worktree ||
        value.projectID !== input.projectID ||
        value.id !== input.checkpointID
      ) {
        return yield* new NotFoundError({ ...input, message: "Checkpoint not found in this worktree" })
      }
      return value
    })

    const captureMemory = Effect.fn("Checkpoint.captureMemory")(function* (projectID: ProjectV2.ID) {
      const rows = yield* database.db
        .select({
          sessionID: SessionContextEpochTable.session_id,
          snapshot: SessionContextEpochTable.snapshot,
        })
        .from(SessionContextEpochTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionContextEpochTable.session_id))
        .where(eq(SessionTable.project_id, projectID))
        .pipe(Effect.orDie)
      return rows
        .map((row) => ({ sessionID: row.sessionID, exists: true, snapshot: row.snapshot }))
        .toSorted((a, b) => a.sessionID.localeCompare(b.sessionID))
    })

    const gitConfig = [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.longpaths=true",
      "-c",
      "core.symlinks=true",
      "-c",
      "core.quotepath=false",
    ]

    const git = Effect.fnUntraced(
      function* (worktree: string, args: string[], env?: Record<string, string>) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", [...gitConfig, ...args], { cwd: worktree, env, extendEnv: true }),
        )
        return {
          code: ChildProcessSpawner.ExitCode(result.exitCode),
          text: result.stdout.toString("utf8").trim(),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) =>
        Effect.succeed({
          code: ChildProcessSpawner.ExitCode(1),
          text: "",
          stderr: err instanceof Error ? err.message : String(err),
        }),
      ),
    )

    const publishFailure = Effect.fnUntraced(function* (ref: string, step: string, stderr: string) {
      yield* Effect.logWarning("failed to publish checkpoint commit", { ref, step, stderr })
      return undefined
    })

    const publishCommit = Effect.fnUntraced(function* (input: {
      readonly worktree: string
      readonly checkpointID: ID
      readonly sessionID: SessionID
      readonly messageID: MessageID
      readonly title?: string
      readonly files: ReadonlyArray<string>
    }) {
      if (input.files.length === 0) return undefined
      const key = Hash.fast(input.worktree)
      const ref = `refs/omai/checkpoints/${key}`
      const dir = yield* git(input.worktree, ["rev-parse", "--absolute-git-dir"])
      if (dir.code !== 0) return yield* publishFailure(ref, "git-dir", dir.stderr)
      const env = { GIT_INDEX_FILE: path.join(dir.text, `omai-checkpoint-${key}.index`) }
      const staged = yield* git(input.worktree, ["add", "-A", "--", "."], env)
      if (staged.code !== 0) return yield* publishFailure(ref, "add", staged.stderr)
      const tree = yield* git(input.worktree, ["write-tree"], env)
      if (tree.code !== 0) return yield* publishFailure(ref, "write-tree", tree.stderr)
      const parent = yield* git(input.worktree, ["rev-parse", "--verify", "--quiet", ref])
      const parentCommit = parent.code === 0 ? parent.text : undefined
      const message = [
        "-m",
        input.title?.trim() || "Checkpoint",
        "-m",
        `OMAI+ checkpoint ${input.checkpointID}\n\nsession: ${input.sessionID}\nmessage: ${input.messageID}`,
      ]
      const commitTree = (commitParent: string | undefined, ident?: Record<string, string>) =>
        git(
          input.worktree,
          ["commit-tree", tree.text, ...(commitParent ? ["-p", commitParent] : []), ...message],
          ident,
        )
      const created = yield* commitTree(parentCommit)
      const committed =
        created.code === 0
          ? created
          : yield* commitTree(parentCommit, {
              GIT_AUTHOR_NAME: "OMAI",
              GIT_AUTHOR_EMAIL: "omai@localhost",
              GIT_COMMITTER_NAME: "OMAI",
              GIT_COMMITTER_EMAIL: "omai@localhost",
            })
      if (committed.code !== 0) return yield* publishFailure(ref, "commit-tree", committed.stderr)
      const linked = yield* git(
        input.worktree,
        parentCommit ? ["update-ref", ref, committed.text, parentCommit] : ["update-ref", ref, committed.text],
      )
      if (linked.code !== 0) return yield* publishFailure(ref, "update-ref", linked.stderr)
      return committed.text
    })

    const create = Effect.fn("Checkpoint.create")(function* (input: CreateInput) {
      const context = yield* InstanceState.context
      return yield* lock(context.project.id + ":" + context.worktree).withPermits(1)(
        Effect.gen(function* () {
          const previous = (yield* load(context.project.id)).find((item) => item.worktree === context.worktree)
          const changes = yield* snapshot.diffFull(input.from, input.hash)
          const databaseValues = yield* inspectDatabase(context.worktree)
          const currentDatabase = databaseValues.map((item) => item.artifact)
          const previousPaths = new Set(previous?.database.filter((item) => item.exists).map((item) => item.path) ?? [])
          const currentPaths = new Set(currentDatabase.map((item) => item.path))
          const database = [
            ...currentDatabase,
            ...Array.from(previousPaths)
              .filter((item) => !currentPaths.has(item))
              .map((item) => ({ path: item, exists: false })),
          ].toSorted((a, b) => a.path.localeCompare(b.path))
          const memory = yield* captureMemory(context.project.id)
          const databaseChanged = !sameDatabase(database, previous?.database)
          const memoryChanged = !sameMemory(memory, previous?.memory)
          if (previous?.snapshotHash === input.hash && !databaseChanged && !memoryChanged) return previous
          if (changes.length === 0 && !databaseChanged && !memoryChanged) return undefined

          const checkpointID = ID.ascending()
          // Every checkpoint owns the artifacts listed in its metadata, including
          // unchanged databases captured alongside a code-only or memory change.
          yield* persistDatabase(context.project.id, context.worktree, checkpointID, databaseValues)
          const files = changes.flatMap((item) => (item.file ? [item.file] : []))
          const commit =
            context.project.vcs === "git"
              ? yield* publishCommit({
                  worktree: context.worktree,
                  checkpointID,
                  sessionID: input.sessionID,
                  messageID: input.messageID,
                  title: input.title,
                  files,
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to publish checkpoint commit", { checkpointID, cause }).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                )
              : undefined
          const value: Info = {
            id: checkpointID,
            parentID: previous?.id,
            projectID: context.project.id,
            worktree: context.worktree,
            snapshotHash: input.hash,
            parentHash: input.from,
            commit,
            sessionID: input.sessionID,
            messageID: input.messageID,
            title: input.title,
            files,
            additions: changes.reduce((total, item) => total + item.additions, 0),
            deletions: changes.reduce((total, item) => total + item.deletions, 0),
            database,
            memory: memoryChanged ? mergeMemory(previous?.memory, memory) : (previous?.memory ?? []),
            time: { created: Date.now() },
          }
          yield* storage.write(["checkpoint", context.project.id, checkpointID], value)
          return value
        }),
      )
    })

    const diff = Effect.fn("Checkpoint.diff")(function* (input: SelectInput) {
      const value = yield* get(input)
      return {
        checkpoint: value.id,
        files: yield* snapshot.diffFull(value.parentHash ?? value.snapshotHash, value.snapshotHash),
      }
    })

    const artifactError = (message: string) =>
      new FSUtil.FileSystemError({ method: "Checkpoint.validateDatabase", cause: new Error(message) })

    const artifactTarget = Effect.fnUntraced(function* (root: string, relative: string) {
      const target = path.join(root, relative)
      const canonical = yield* Effect.tryPromise({
        try: () => CentralStorage.resolveUnder(root, target),
        catch: (cause) => new FSUtil.FileSystemError({ method: "Checkpoint.validateDatabase", cause }),
      })
      if (canonical !== target) return yield* artifactError("Checkpoint database paths must not contain symlinks")
      return target
    })

    const prepareDatabase = Effect.fn("Checkpoint.prepareDatabase")(function* (worktree: string, checkpoint: Info) {
      if (!/^[A-Za-z0-9_-]+$/.test(checkpoint.projectID) || !/^chk[A-Za-z0-9_-]*$/.test(checkpoint.id))
        return yield* artifactError("Checkpoint contains an unsafe identifier")
      const root = yield* fs.realPath(Global.Path.data)
      const known = new Set<string>()
      // Validate the entire manifest before reading any artifact or changing live state.
      for (const item of checkpoint.database) {
        if (
          !item.path ||
          item.path.includes("\\") ||
          item.path.includes("\0") ||
          path.isAbsolute(item.path) ||
          item.path.split("/").some((part) => !part || part === "." || part === ".." || excluded.has(part)) ||
          known.has(item.path)
        )
          return yield* artifactError("Checkpoint contains an unsafe or repeated database path")
        known.add(item.path)
        if (
          item.exists &&
          (!Number.isSafeInteger(item.size) || item.size! < 0 || !/^[a-f0-9]{64}$/.test(item.hash ?? ""))
        )
          return yield* artifactError("Checkpoint database requires a byte count and SHA-256 hash")
        yield* artifactTarget(worktree, item.path)
      }
      for (const relative of yield* discoverDatabase(worktree)) yield* artifactTarget(worktree, relative)
      // Keep verified bytes until restoration, so no late artifact read can fail after a session/Git mutation.
      return yield* Effect.forEach(
        checkpoint.database.filter((item) => item.exists),
        (item) =>
          Effect.gen(function* () {
            const source = yield* artifactTarget(
              root,
              path.relative(Global.Path.data, artifactPath(checkpoint.projectID, worktree, checkpoint.id, item.path)),
            )
            const stat = yield* fs.stat(source)
            if (stat.type !== "File" || stat.size !== BigInt(item.size!))
              return yield* artifactError(`Checkpoint database size does not match: ${item.path}`)
            const content = yield* fs.readFile(source)
            if (content.byteLength !== item.size || Hash.sha256(Buffer.from(content)) !== item.hash)
              return yield* artifactError(`Checkpoint database SHA-256 does not match: ${item.path}`)
            return { path: item.path, content }
          }),
        { concurrency: 4 },
      )
    })

    const restoreDatabase = Effect.fnUntraced(function* (
      worktree: string,
      values: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>,
    ) {
      const expected = new Set(values.map((item) => item.path))
      const current = yield* discoverDatabase(worktree)
      yield* Effect.forEach(
        Array.from(current).filter((item) => !expected.has(item)),
        (item) => artifactTarget(worktree, item).pipe(Effect.flatMap((target) => fs.remove(target))),
        { concurrency: 4 },
      )
      yield* Effect.forEach(
        values,
        (item) =>
          Effect.gen(function* () {
            const target = yield* artifactTarget(worktree, item.path)
            yield* fs.writeWithDirs(target, item.content)
          }),
        { concurrency: 1 },
      )
    })

    const restoreMemory = Effect.fnUntraced(function* (checkpoint: Info) {
      const current = yield* database.db
        .select({ sessionID: SessionContextEpochTable.session_id })
        .from(SessionContextEpochTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionContextEpochTable.session_id))
        .where(eq(SessionTable.project_id, checkpoint.projectID))
        .pipe(Effect.orDie)
      const target = new Map(checkpoint.memory.map((item) => [item.sessionID, item]))
      yield* Effect.forEach(
        current,
        (row) => {
          const item = target.get(row.sessionID)
          if (item?.exists && item.snapshot) {
            return database.db
              .update(SessionContextEpochTable)
              .set({ snapshot: item.snapshot })
              .where(eq(SessionContextEpochTable.session_id, row.sessionID))
              .pipe(Effect.orDie)
          }
          return database.db
            .delete(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, row.sessionID))
            .pipe(Effect.orDie)
        },
        { concurrency: 1 },
      )
    })

    const rollback = Effect.fn("Checkpoint.rollback")(function* (input: SelectInput) {
      const value = yield* get(input)
      const context = yield* requireContext(input.projectID)
      const artifacts = yield* prepareDatabase(context.worktree, value)
      if (!/^[a-f0-9]{40}$/.test(value.snapshotHash))
        return yield* artifactError("Checkpoint contains an invalid snapshot tree")
      const tree = yield* git(
        context.worktree,
        [
          "--git-dir",
          path.join(Global.Path.data, "snapshot", input.projectID, Hash.fast(context.worktree)),
          "cat-file",
          "-e",
          `${value.snapshotHash}^{tree}`,
        ],
        { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      )
      if (tree.code !== 0) return yield* artifactError("Checkpoint snapshot tree is missing or unreadable")
      const rows = yield* database.db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.project_id, input.projectID))
        .pipe(Effect.orDie)
      yield* Effect.forEach(rows, (row) => revert.revertAfter({ sessionID: row.id, messageID: value.messageID }), {
        concurrency: 1,
      })
      yield* snapshot.revert([yield* snapshot.patch(value.snapshotHash)])
      yield* restoreDatabase(context.worktree, artifacts)
      yield* restoreMemory(value)
      return value
    })

    return Service.of({ create, list, diff, rollback })
  }),
)

function artifactPath(projectID: ProjectV2.ID, worktree: string, checkpointID: ID, relative: string) {
  return path.join(
    Global.Path.data,
    "checkpoint",
    projectID,
    Hash.fast(worktree),
    checkpointID,
    "database",
    ...relative.split("/"),
  )
}

function sameDatabase(current: ReadonlyArray<Artifact>, previous: ReadonlyArray<Artifact> | undefined) {
  if (!previous) return current.length === 0
  return JSON.stringify(current) === JSON.stringify(previous)
}

function sameMemory(current: ReadonlyArray<Memory>, previous: ReadonlyArray<Memory> | undefined) {
  if (!previous) return current.length === 0
  return JSON.stringify(current) === JSON.stringify(previous.filter((item) => item.exists))
}

function mergeMemory(previous: ReadonlyArray<Memory> | undefined, current: ReadonlyArray<Memory>) {
  const currentIDs = new Set(current.map((item) => item.sessionID))
  return [
    ...current,
    ...(previous ?? [])
      .filter((item) => item.exists && !currentIDs.has(item.sessionID))
      .map((item) => ({ sessionID: item.sessionID, exists: false })),
  ].toSorted((a, b) => a.sessionID.localeCompare(b.sessionID))
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [FSUtil.node, Storage.node, Snapshot.node, Database.node, AppProcess.node, SessionRevert.node],
})

export * as Checkpoint from "."
