import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceStateTable } from "@opencode-ai/core/instance-state/sql"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PublishDeploymentTable } from "@opencode-ai/core/publish/sql"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus } from "@/bus/global"
import { which } from "@opencode-ai/core/util/which"
import { Command } from "@/command"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer, Scope, Context, Stream, Types, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { ProjectV2 } from "@opencode-ai/core/project"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { CentralStorage } from "@opencode-ai/core/storage/central"
import { vmProjectsRoot } from "@/control-plane/vm-projects"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { Project } from "@opencode-ai/schema/project"
import os from "os"
import path from "path"

export const Info = Project.Info
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Event = {
  Updated: Project.Event.Updated,
}

type Row = typeof ProjectTable.$inferSelect

export function fromRow(row: Row): Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(Project.Vcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    sandboxes: row.sandboxes,
    commands: row.commands ?? undefined,
  }
}

export const UpdateInput = Schema.Struct({
  projectID: ProjectV2.ID,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.Icon),
  commands: Schema.optional(Project.Commands),
})
export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.Icon),
  commands: Schema.optional(Project.Commands),
}).annotate({ identifier: "ProjectUpdateInput" })
export type UpdatePayload = Types.DeepMutable<Schema.Schema.Type<typeof UpdatePayload>>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Project.NotFoundError", {
  projectID: ProjectV2.ID,
}) {}

export class InvalidTargetError extends Schema.TaggedErrorClass<InvalidTargetError>()("Project.InvalidTargetError", {
  projectID: ProjectV2.ID,
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  /**
   * Per-instance setup. Subscribes to the `/init` slash command for the
   * current instance and stamps the project's initialized timestamp when it
   * fires. Subscription lifetime is tied to the per-instance state scope.
   */
  readonly init: () => Effect.Effect<void>
  readonly fromDirectory: (directory: string) => Effect.Effect<{ project: Info; sandbox: string }>
  readonly discover: (input: Info) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: ProjectV2.ID) => Effect.Effect<Info | undefined>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: ProjectV2.ID) => Effect.Effect<void, NotFoundError | InvalidTargetError>
  readonly initGit: (input: { directory: string; project: Info; force?: boolean }) => Effect.Effect<Info>
  readonly setInitialized: (id: ProjectV2.ID) => Effect.Effect<void>
  readonly sandboxes: (id: ProjectV2.ID) => Effect.Effect<string[]>
  readonly addSandbox: (id: ProjectV2.ID, directory: string) => Effect.Effect<void>
  readonly removeSandbox: (id: ProjectV2.ID, directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Project") {}

type GitResult = { code: number; text: string; stderr: string }

const runGit = Effect.fnUntraced(
  function* (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make("git", args, { cwd: opts?.cwd, env: opts?.env, extendEnv: true, stdin: "ignore" }),
    )
    const [text, stderr] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
      { concurrency: 2 },
    )
    const code = yield* handle.exitCode
    return { code, text, stderr } satisfies GitResult
  },
  Effect.scoped,
  Effect.catch(() => Effect.succeed({ code: 1, text: "", stderr: "" } satisfies GitResult)),
)

export const gitInitRepo = Effect.fn("Project.gitInitRepo")(function* (directory: string) {
  const fs = yield* FSUtil.Service
  if (!(yield* Effect.sync(() => which("git")))) throw new Error("Git is not installed")
  // A zip upload can carry its own repository; drop any existing .git so the
  // project always starts from a fresh repository with an initial commit.
  yield* fs.remove(path.join(directory, ".git"), { recursive: true, force: true }).pipe(Effect.ignore)
  // Volume mount points are owned by root while the server runs as a
  // non-root user, so git would otherwise reject the directory as having
  // "dubious ownership". Allow it explicitly for this repository.
  const init = yield* runGit(["-c", "safe.directory=*", "init", "--quiet"], { cwd: directory })
  if (init.code !== 0) {
    throw new Error(init.stderr.trim() || init.text.trim() || "Failed to initialize git repository")
  }
  yield* runGit(["-c", "safe.directory=*", "add", "-A"], { cwd: directory })
  const commit = yield* runGit(["-c", "safe.directory=*", "commit", "--quiet", "--allow-empty", "-m", "Initial commit"], {
    cwd: directory,
    env: {
      GIT_AUTHOR_NAME: "OMAI",
      GIT_AUTHOR_EMAIL: "omai@localhost",
      GIT_COMMITTER_NAME: "OMAI",
      GIT_COMMITTER_EMAIL: "omai@localhost",
    },
  })
  if (commit.code !== 0) {
    throw new Error(commit.stderr.trim() || commit.text.trim() || "Failed to create initial commit")
  }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const projectV2 = yield* ProjectV2.Service
    const projectDirectories = yield* ProjectDirectories.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const session = yield* Session.Service
    const { db } = yield* Database.Service

    const emitUpdated = (data: Info) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          project: data.id,
          payload: { type: Event.Updated.type, properties: data },
        }),
      )

    const fakeVcs = Schema.decodeUnknownSync(Schema.optional(Project.Vcs))(Flag.OPENCODE_FAKE_VCS)

    const scope = yield* Scope.Scope

    const migrateProjectId = Effect.fn("Project.migrateProjectId")(function* (
      oldID: ProjectV2.ID | undefined,
      newID: ProjectV2.ID,
    ) {
      if (!oldID) return
      if (oldID === ProjectV2.ID.global) return
      if (oldID === newID) return

      yield* db
        .transaction((d) =>
          Effect.gen(function* () {
            // Serialize both identities in a stable order, including the case
            // where the destination row does not exist yet.
            for (const id of [oldID, newID].toSorted()) {
              yield* d.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`omai:project:${id}`}, 0))`)
            }
            const oldProject = yield* d
              .select()
              .from(ProjectTable)
              .where(eq(ProjectTable.id, oldID))
              .pipe(Database.first)
            const newProject = yield* d
              .select()
              .from(ProjectTable)
              .where(eq(ProjectTable.id, newID))
              .pipe(Database.first)
            if (oldProject && !newProject) {
              yield* d.insert(ProjectTable).values({
                ...oldProject,
                id: newID,
                time_updated: Date.now(),
              })
            }

            // Project directories may be shared across distinct
            // checkouts which have diverged. Clear the directory
            // list and rely on it being re-populated to ensure
            // accuracy
            yield* d.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, oldID))

            yield* d
              .update(SessionTable)
              .set({ project_id: newID, time_updated: sql`${SessionTable.time_updated}` })
              .where(eq(SessionTable.project_id, oldID))
            yield* d.update(WorkspaceTable).set({ project_id: newID }).where(eq(WorkspaceTable.project_id, oldID))

            const permissions = yield* d.select().from(PermissionTable).where(eq(PermissionTable.project_id, oldID))
            if (permissions.length) {
              yield* d.delete(PermissionTable).where(eq(PermissionTable.project_id, oldID))
              yield* d
                .insert(PermissionTable)
                .values(permissions.map((permission) => ({ ...permission, project_id: newID })))
                .onConflictDoNothing({
                  target: [PermissionTable.project_id, PermissionTable.action, PermissionTable.resource],
                })
            }
            yield* d
              .update(PublishDeploymentTable)
              .set({ project_id: newID })
              .where(eq(PublishDeploymentTable.project_id, oldID))

            if (oldProject) yield* d.delete(ProjectTable).where(eq(ProjectTable.id, oldID))
          }),
        )
        .pipe(Effect.orDie)
    })

    const saveProjectDirectory = Effect.fn("Project.saveProjectDirectory")(function* (input: {
      projectID: ProjectV2.ID
      directory: string
    }) {
      if (input.projectID === ProjectV2.ID.global) return
      const opened = AbsolutePath.make(FSUtil.resolve(input.directory))
      yield* projectDirectories
        .create({
          directory: opened,
          projectID: input.projectID,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project directory persistence failed", { projectID: input.projectID, cause }),
          ),
        )
    })

    const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
      yield* Effect.logInfo("fromDirectory", { directory })

      const data = yield* projectV2.resolve(AbsolutePath.make(directory))
      const worktree = data.id === ProjectV2.ID.make("global") && !data.vcs ? "/" : data.directory

      // Phase 2: upsert
      const projectID = ProjectV2.ID.make(data.id)
      yield* migrateProjectId(data.previous ? ProjectV2.ID.make(data.previous) : undefined, projectID)
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, projectID))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      const existing = row
        ? fromRow(row)
        : {
            id: projectID,
            worktree,
            vcs: data.vcs?.type ?? fakeVcs,
            sandboxes: [] as string[],
            time: { created: Date.now(), updated: Date.now() },
          }

      if (flags.experimentalIconDiscovery) yield* discover(existing).pipe(Effect.ignore, Effect.forkIn(scope))

      const result: Info = {
        ...existing,
        worktree: projectID === ProjectV2.ID.global ? worktree : existing.worktree,
        vcs: data.vcs?.type ?? fakeVcs,
        time: { ...existing.time, updated: Date.now() },
      }
      if (
        projectID !== ProjectV2.ID.global &&
        data.directory !== result.worktree &&
        !result.sandboxes.includes(data.directory)
      )
        result.sandboxes.push(data.directory)
      result.sandboxes = yield* Effect.forEach(
        result.sandboxes,
        (s) =>
          fs.exists(s).pipe(
            Effect.orDie,
            Effect.map((exists) => (exists ? s : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))

      yield* db
        .insert(ProjectTable)
        .values({
          id: result.id,
          worktree: AbsolutePath.make(result.worktree),
          vcs: result.vcs ?? null,
          name: result.name,
          icon_url: result.icon?.url,
          icon_url_override: result.icon?.override,
          icon_color: result.icon?.color,
          time_created: result.time.created,
          time_updated: result.time.updated,
          time_initialized: result.time.initialized,
          sandboxes: result.sandboxes.map((sandbox) => AbsolutePath.make(sandbox)),
          commands: result.commands,
        })
        .onConflictDoUpdate({
          target: ProjectTable.id,
          set: {
            worktree: AbsolutePath.make(result.worktree),
            vcs: result.vcs ?? null,
            name: result.name,
            icon_url: result.icon?.url,
            icon_url_override: result.icon?.override,
            icon_color: result.icon?.color,
            time_updated: result.time.updated,
            time_initialized: result.time.initialized,
            sandboxes: result.sandboxes.map((sandbox) => AbsolutePath.make(sandbox)),
            commands: result.commands,
          },
        })
        .pipe(Effect.orDie)

      if (projectID !== ProjectV2.ID.global) {
        yield* db
          .update(SessionTable)
          .set({ project_id: projectID })
          .where(and(eq(SessionTable.project_id, ProjectV2.ID.global), eq(SessionTable.directory, data.directory)))
          .pipe(Effect.orDie)
      }

      yield* saveProjectDirectory({
        projectID,
        directory: data.directory,
      })

      yield* emitUpdated(result)
      if (projectID !== ProjectV2.ID.global && data.vcs?.type === "git") {
        yield* projectV2.commit({ store: data.vcs.store, id: data.id })
      }
      return { project: result, sandbox: data.vcs ? data.directory : worktree }
    })

    const discover = Effect.fn("Project.discover")(function* (input: Info) {
      if (input.vcs !== "git") return
      if (input.icon?.override) return
      if (input.icon?.url) return

      const matches = yield* fs
        .glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
          cwd: input.worktree,
          absolute: true,
          include: "file",
        })
        .pipe(Effect.orDie)
      const shortest = matches.sort((a, b) => a.length - b.length)[0]
      if (!shortest) return

      const buffer = yield* fs.readFile(shortest).pipe(Effect.orDie)
      const base64 = Buffer.from(buffer).toString("base64")
      const mime = FSUtil.mimeType(shortest)
      const url = `data:${mime};base64,${base64}`
      yield* update({ projectID: input.id, icon: { url } }).pipe(
        Effect.catchTag("Project.NotFoundError", () => Effect.void),
      )
    })

    const list = Effect.fn("Project.list")(function* () {
      return (yield* db.select().from(ProjectTable).pipe(Effect.orDie)).map(fromRow)
    })

    const get = Effect.fn("Project.get")(function* (id: ProjectV2.ID) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, id))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      const result = yield* db
        .update(ProjectTable)
        .set({
          name: input.name,
          icon_url: input.icon?.url,
          icon_url_override: input.icon?.override,
          icon_color: input.icon?.color,
          commands: input.commands,
          time_updated: Date.now(),
        })
        .where(eq(ProjectTable.id, input.projectID))
        .returning()
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!result) return yield* new NotFoundError({ projectID: input.projectID })
      const data = fromRow(result)
      yield* emitUpdated(data)
      return data
    })

    const remove = Effect.fn("Project.remove")(function* (id: ProjectV2.ID) {
      if (id === ProjectV2.ID.global)
        return yield* new InvalidTargetError({ projectID: id, message: "The global project cannot be deleted" })
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, id))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ projectID: id })

      const worktree = FSUtil.resolve(row.worktree)
      const vmRoot = vmProjectsRoot()
      const isVmPath = !!vmRoot && worktree.startsWith(`${vmRoot}/`)
      const root = CentralStorage.workspaceRoot()
      if (root && !isVmPath) {
        yield* Effect.promise(() => CentralStorage.resolveUnder(root, worktree)).pipe(
          Effect.catch(() =>
            Effect.fail(
              new InvalidTargetError({
                projectID: id,
                message: `Refusing to delete a directory outside the workspace: ${worktree}`,
              }),
            ),
          ),
        )
      } else if (!isVmPath && (worktree === "/" || worktree === os.homedir())) {
        return yield* new InvalidTargetError({
          projectID: id,
          message: `Refusing to delete a protected directory: ${worktree}`,
        })
      }

      const sessions = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.project_id, id))
        .pipe(Effect.orDie)
      // A session row that vanishes mid-delete is already gone; the rest of
      // the project cleanup must still run.
      yield* Effect.forEach(sessions, (item) => session.remove(item.id).pipe(Effect.ignore), {
        concurrency: 1,
        discard: true,
      })

      // Checkpoint rows live in instance_state without a foreign key, and the
      // project id derives from the directory, so a recreated project would
      // otherwise inherit stale checkpoints.
      const prefix = `["checkpoint","${id}"`
      const pattern = `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
      yield* db
        .delete(InstanceStateTable)
        .where(
          and(
            eq(InstanceStateTable.namespace, Storage.namespace),
            sql`${InstanceStateTable.key} like ${pattern} escape '\\'`,
          ),
        )
        .pipe(Effect.orDie)
      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, id)).pipe(Effect.orDie)

      yield* fs
        .remove(worktree, { recursive: true, force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project directory removal failed", { projectID: id, worktree, cause }),
          ),
        )
      yield* fs
        .remove(path.join(Global.Path.data, "checkpoint", id), { recursive: true, force: true })
        .pipe(Effect.ignore)
      yield* fs
        .remove(path.join(Global.Path.data, "snapshot", id), { recursive: true, force: true })
        .pipe(Effect.ignore)
    })

    const initGit = Effect.fn("Project.initGit")(function* (input: {
      directory: string
      project: Info
      force?: boolean
    }) {
      if (input.project.vcs === "git" && !input.force) return input.project
      yield* gitInitRepo(input.directory).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FSUtil.Service, fs),
      )
      const { project } = yield* fromDirectory(input.directory)
      return project
    })

    const setInitialized = Effect.fn("Project.setInitialized")(function* (id: ProjectV2.ID) {
      yield* db
        .update(ProjectTable)
        .set({ time_initialized: Date.now() })
        .where(eq(ProjectTable.id, id))
        .pipe(Effect.orDie)
    })

    const initState = yield* InstanceState.make(
      Effect.fn("Project.initState")(function* (ctx) {
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Command.Event.Executed.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Command.Event.Executed>
          return data.name === Command.Default.INIT ? setInitialized(ctx.project.id) : Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
      }),
    )

    const init = Effect.fn("Project.init")(function* () {
      yield* InstanceState.get(initState)
    })

    const sandboxes = Effect.fn("Project.sandboxes")(function* (id: ProjectV2.ID) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, id))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!row) return []
      const data = fromRow(row)
      return yield* Effect.forEach(
        data.sandboxes,
        (dir) =>
          fs.isDir(dir).pipe(
            Effect.orDie,
            Effect.map((ok) => (ok ? dir : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))
    })

    const addSandbox = Effect.fn("Project.addSandbox")(function* (id: ProjectV2.ID, directory: string) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, id))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!row) throw new Error(`Project not found: ${id}`)
      const sandbox = AbsolutePath.make(directory)
      const sboxes = [...row.sandboxes]
      if (!sboxes.includes(sandbox)) sboxes.push(sandbox)
      const result = yield* db
        .update(ProjectTable)
        .set({ sandboxes: sboxes, time_updated: Date.now() })
        .where(eq(ProjectTable.id, id))
        .returning()
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
    })

    const removeSandbox = Effect.fn("Project.removeSandbox")(function* (id: ProjectV2.ID, directory: string) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, id))
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!row) throw new Error(`Project not found: ${id}`)
      const sandbox = AbsolutePath.make(directory)
      const sboxes = row.sandboxes.filter((s) => s !== sandbox)
      const result = yield* db
        .update(ProjectTable)
        .set({ sandboxes: sboxes, time_updated: Date.now() })
        .where(eq(ProjectTable.id, id))
        .returning()
        .pipe(Database.first)
        .pipe(Effect.orDie)
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
    })

    return Service.of({
      init,
      fromDirectory,
      discover,
      list,
      get,
      update,
      remove,
      initGit,
      setInitialized,
      sandboxes,
      addSandbox,
      removeSandbox,
    })
  }),
)

export const use = serviceUse(Service)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    FSUtil.node,
    AppProcess.node,
    CrossSpawnSpawner.node,
    ProjectV2.node,
    ProjectDirectories.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Session.node,
    Database.node,
  ],
})

export * as Project from "./project"
