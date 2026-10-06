export * as SnapshotImport from "./import-snapshots"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { SQLiteImport } from "../database/postgres/import-sqlite"
import { CentralStorage } from "./central"

export interface WorktreeMapping extends SQLiteImport.PathMapping {
  readonly projectID: string
}

export interface Input {
  readonly source: string
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly workspaceRoot: string
  readonly worktrees: ReadonlyArray<WorktreeMapping>
  readonly objects?: ReadonlyArray<SQLiteImport.PathMapping>
  readonly apply?: boolean
}

interface Plan {
  readonly projectID: string
  readonly directory: string
  readonly destination: string
  readonly worktree: string
  readonly trees: string[]
  readonly alternates: string[]
}

const hash = (input: string) => createHash("sha1").update(input).digest("hex")
const json = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "string") throw new Error("Snapshot metadata must contain JSON text")
  const result = JSON.parse(input)
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new Error("Snapshot metadata must be a JSON object")
  return result
}

/** No project hooks, Git configuration commands, credential helpers, or lazy object downloads are allowed. */
async function git(directory: string, args: string[], alternates: string[] = [], input?: string) {
  const child = Bun.spawn(
    [
      "git",
      "--no-optional-locks",
      "--git-dir",
      directory,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH,
        LANG: "C",
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(path.delimiter),
      },
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Snapshot Git ${args[0]} failed: ${stderr.trim().slice(0, 2000)}`)
  return stdout.trim()
}

async function assertDirectory(directory: string) {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Snapshot migration requires real directories, not symlinks")
}

async function absent(filename: string) {
  const existing = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing)
    throw new Error("Snapshot destination already exists; migration never overwrites an existing repository")
}

async function files(directory: string): Promise<string[]> {
  await assertDirectory(directory)
  const result: string[] = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await files(filename)))
    else if (entry.isFile()) result.push(filename)
    else throw new Error("Snapshot source contains a symlink or unsupported filesystem entry")
  }
  return result
}

/** Frozen metadata is used only to prove tree coverage; it is never migrated or modified here. */
function references(database: Awaited<ReturnType<typeof SQLiteImport.openSource>>["database"]) {
  const sessions = new Map(
    database
      .query<{ id: string; project_id: string }, []>("select id, project_id from session")
      .all()
      .map((row) => [row.id, row.project_id]),
  )
  const result = new Map<string, Set<string>>()
  const add = (session: string, value: unknown) => {
    if (value === undefined || value === null) return
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
      throw new Error("Unsupported snapshot tree identifier in source metadata")
    const project = sessions.get(session)
    if (!project) throw new Error("Snapshot metadata refers to an unknown session")
    const values = result.get(project) ?? new Set<string>()
    values.add(value)
    result.set(project, values)
  }
  for (const row of database
    .query<{ id: string; revert: string }, []>("select id, revert from session where revert is not null")
    .all())
    add(row.id, json(row.revert).snapshot)
  for (const row of database
    .query<{ session_id: string; data: string }, []>("select session_id, data from session_message")
    .all()) {
    const snapshot = json(row.data).snapshot
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      const value = snapshot as Record<string, unknown>
      add(row.session_id, value.start)
      add(row.session_id, value.end)
    }
  }
  for (const row of database
    .query<{ session_id: string; data: string }, []>("select session_id, data from part")
    .all()) {
    const data = json(row.data)
    if (["snapshot", "step-start", "step-finish"].includes(String(data.type))) add(row.session_id, data.snapshot)
    if (data.type === "patch") add(row.session_id, data.hash)
  }
  for (const row of database
    .query<{ aggregate_id: string; type: string; data: string }, []>("select aggregate_id, type, data from event")
    .all()) {
    const data = json(row.data)
    if (row.type === "session.next.step.started" || row.type === "session.next.step.ended")
      add(row.aggregate_id, data.snapshot)
    if (
      (row.type === "session.created" || row.type === "session.updated") &&
      data.info &&
      typeof data.info === "object"
    ) {
      const info = data.info as Record<string, unknown>
      const revert = info.revert
      if (revert && typeof revert === "object") add(String(info.id), (revert as Record<string, unknown>).snapshot)
    }
  }
  return result
}

/** The operator holds the volume writer lock and stops both instances before invoking this operation. */
export async function run(input: Input) {
  const sourceRoot = await fs.realpath(input.sourceRoot)
  await assertDirectory(sourceRoot)
  const workspaceRoot = await fs.realpath(input.workspaceRoot)
  const targetRoot = await CentralStorage.resolveUnder(path.dirname(workspaceRoot), input.targetRoot)
  if (
    targetRoot === sourceRoot ||
    targetRoot.startsWith(sourceRoot + path.sep) ||
    sourceRoot.startsWith(targetRoot + path.sep)
  )
    throw new Error("Source and destination snapshot roots must be disjoint")
  const source = await SQLiteImport.openSource(input.source)
  const staged: string[] = []
  const published: string[] = []
  try {
    const required = references(source.database)
    const covered = new Map<string, Set<string>>()
    const plans: Plan[] = []
    const known = new Set<string>()
    for (const mapping of input.worktrees) {
      if (
        !/^[A-Za-z0-9_-]+$/.test(mapping.projectID) ||
        !path.isAbsolute(mapping.from) ||
        path.normalize(mapping.from) !== mapping.from
      )
        throw new Error("Snapshot mappings require a safe project ID and exact canonical old absolute worktree path")
      const worktree = await CentralStorage.resolveUnder(workspaceRoot, mapping.to)
      await assertDirectory(worktree)
      const directory = path.join(sourceRoot, mapping.projectID, hash(mapping.from))
      const destination = path.join(targetRoot, mapping.projectID, hash(worktree))
      if (known.has(directory) || plans.some((plan) => plan.destination === destination))
        throw new Error("Snapshot mappings must be unique")
      known.add(directory)
      await CentralStorage.resolveUnder(sourceRoot, directory)
      await files(directory)
      await absent(destination)
      await absent(path.join(directory, "commondir"))
      const alternateFile = path.join(directory, "objects", "info", "alternates")
      const alternateText = await fs.readFile(alternateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      const alternates = []
      for (const value of alternateText.split("\n").filter(Boolean)) {
        if (value.includes('"') || value.includes("\r"))
          throw new Error("Unsupported quoted snapshot object alternate; provide a normalized offline archive")
        const absolute = path.resolve(directory, "objects", value)
        const mapped = input.objects?.length ? SQLiteImport.mapPath(absolute, input.objects) : absolute
        if (mapped.includes(path.delimiter)) throw new Error("Unsupported delimiter in Git object archive path")
        await assertDirectory(mapped)
        const nested = await fs
          .readFile(path.join(mapped, "info", "alternates"), "utf8")
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return ""
            throw error
          })
        if (nested.trim())
          throw new Error(
            "Object archives must be self-contained; nested alternates require an explicit offline archive first",
          )
        alternates.push(mapped)
      }
      const listing = await git(
        directory,
        ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
        alternates,
      )
      // Preserve every stored tree, including old unreachable trees whose metadata was pruned previously.
      const trees = listing.split("\n").flatMap((line) => (/^[0-9a-f]{40} tree$/.test(line) ? [line.slice(0, 40)] : []))
      const values = covered.get(mapping.projectID) ?? new Set<string>()
      for (const tree of trees) values.add(tree)
      covered.set(mapping.projectID, values)
      await git(directory, ["fsck", "--full", "--no-reflogs", "--no-dangling"], alternates)
      plans.push({ projectID: mapping.projectID, directory, destination, worktree, trees, alternates })
    }
    for (const project of await fs.readdir(sourceRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) throw new Error("Unexpected entry in source snapshot root")
      for (const entry of await fs.readdir(path.join(sourceRoot, project.name), { withFileTypes: true })) {
        if (!entry.isDirectory() || !known.has(path.join(sourceRoot, project.name, entry.name)))
          throw new Error("Every source snapshot repository needs an explicit worktree mapping")
      }
    }
    for (const [project, trees] of required)
      for (const tree of trees) {
        if (!covered.get(project)?.has(tree))
          throw new Error(`Referenced snapshot tree is unavailable for project ${project}: ${tree}`)
      }
    if (input.apply) {
      await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 })
      for (const plan of plans) {
        const stage = await fs.mkdtemp(path.join(targetRoot, ".import-"))
        staged.push(stage)
        await fs.cp(plan.directory, stage, { recursive: true, errorOnExist: true, force: false })
        await fs.rm(path.join(stage, "hooks"), { recursive: true, force: true })
        await fs.writeFile(
          path.join(stage, "config"),
          "[core]\n\trepositoryformatversion = 0\n\tbare = true\n\thooksPath = /dev/null\n\tfsmonitor = false\n",
        )
        await fs.mkdir(path.join(stage, "objects", "info"), { recursive: true })
        await fs.writeFile(path.join(stage, "objects", "info", "alternates"), plan.alternates.join("\n") + "\n")
        if (plan.trees.length)
          await git(
            stage,
            ["update-ref", "--stdin"],
            [],
            plan.trees.map((tree) => `update refs/opencode/snapshots/${tree} ${tree}`).join("\n") + "\n",
          )
        await git(stage, ["repack", "-a", "-d"])
        await fs.rm(path.join(stage, "objects", "info", "alternates"))
        await git(stage, ["fsck", "--full", "--no-reflogs", "--no-dangling"])
        await fs.mkdir(path.dirname(plan.destination), { recursive: true, mode: 0o700 })
        await absent(plan.destination)
        await fs.rename(stage, plan.destination)
        published.push(plan.destination)
      }
    }
    return {
      sourceSha256: source.sha256,
      applied: input.apply === true,
      repositories: plans.map((plan) => ({
        projectID: plan.projectID,
        source: plan.directory,
        destination: plan.destination,
        worktree: plan.worktree,
        trees: plan.trees.length,
      })),
      referencedTrees: Array.from(required.values()).reduce((total, trees) => total + trees.size, 0),
    }
  } catch (cause) {
    for (const directory of published) await fs.rm(directory, { recursive: true, force: true })
    throw cause
  } finally {
    source.database.close()
    for (const directory of staged) await fs.rm(directory, { recursive: true, force: true })
  }
}
