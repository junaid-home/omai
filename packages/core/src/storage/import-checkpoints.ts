export * as CheckpointImport from "./import-checkpoints"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { CentralStorage } from "./central"

const Metadata = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  worktree: Schema.String,
  snapshotHash: Schema.String,
  parentID: Schema.optional(Schema.String),
  parentHash: Schema.optional(Schema.String),
  database: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      exists: Schema.Boolean,
      size: Schema.optional(Schema.Number),
      hash: Schema.optional(Schema.String),
    }),
  ),
})
export type Metadata = typeof Metadata.Type

export interface Input {
  readonly source: string
  readonly sourceDataRoot: string
  readonly targetDataRoot: string
  readonly workspaceRoot: string
  readonly paths: ReadonlyArray<{ readonly from: string; readonly to: string }>
  readonly apply?: boolean
}

const hash = (value: string) => createHash("sha1").update(value).digest("hex")
const digest = async (filename: string) => {
  const result = createHash("sha256")
  for await (const bytes of Bun.file(filename).stream()) result.update(bytes)
  return result.digest("hex")
}
const decode = Schema.decodeUnknownSync(Metadata)
const json = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

export function parse(value: unknown): Metadata {
  const result = decode(value)
  if (
    !/^[A-Za-z0-9_-]+$/.test(result.projectID) ||
    !/^chk[A-Za-z0-9_-]*$/.test(result.id) ||
    (result.parentID !== undefined && !/^chk[A-Za-z0-9_-]*$/.test(result.parentID))
  )
    throw new Error("Checkpoint metadata contains an unsafe identifier")
  if (!path.isAbsolute(result.worktree) || path.normalize(result.worktree) !== result.worktree)
    throw new Error("Checkpoint migration requires an exact canonical POSIX worktree path")
  if (![result.snapshotHash, result.parentHash].every((value) => value === undefined || /^[a-f0-9]{40}$/.test(value)))
    throw new Error("Checkpoint metadata contains an invalid snapshot tree")
  const known = new Set<string>()
  for (const artifact of result.database) {
    if (
      !artifact.path ||
      artifact.path.includes("\\") ||
      artifact.path.includes("\0") ||
      artifact.path.split("/").some((part) => !part || part === "." || part === "..") ||
      path.isAbsolute(artifact.path) ||
      known.has(artifact.path)
    )
      throw new Error("Checkpoint metadata contains an unsafe or repeated artifact path")
    known.add(artifact.path)
    if (
      artifact.exists &&
      (!Number.isSafeInteger(artifact.size) ||
        artifact.size! < 0 ||
        !artifact.hash ||
        !/^[a-f0-9]{64}$/.test(artifact.hash))
    )
      throw new Error("Existing checkpoint artifacts require an exact byte count and SHA-256 hash")
  }
  return result
}

async function regular(root: string, filename: string) {
  if ((await CentralStorage.resolveUnder(root, filename)) !== filename)
    throw new Error("Checkpoint import refuses symlink paths")
  const stat = await fs.lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Checkpoint import refuses non-regular files")
  return stat
}

async function absent(filename: string) {
  const present = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (present) throw new Error("Checkpoint import never overwrites an existing destination")
}

function directory(root: string, value: Metadata) {
  return path.join(root, "checkpoint", value.projectID, hash(value.worktree), value.id)
}

async function verifyFile(root: string, filename: string, artifact: Metadata["database"][number]) {
  if ((await regular(root, filename)).size !== artifact.size || (await digest(filename)) !== artifact.hash)
    throw new Error("Checkpoint artifact size or SHA-256 does not match its metadata")
}

/** Require the complete filesystem side before publishing migrated metadata to PostgreSQL. */
export async function verifyTarget(value: unknown, targetDataRoot: string): Promise<void> {
  const checkpoint = parse(value)
  const root = await fs.realpath(targetDataRoot)
  for (const artifact of checkpoint.database) {
    if (!artifact.exists) continue
    await verifyFile(root, path.join(directory(root, checkpoint), "database", artifact.path), artifact)
  }
  const repository = path.join(root, "snapshot", checkpoint.projectID, hash(checkpoint.worktree))
  await CentralStorage.resolveUnder(root, repository)
  for (const tree of new Set([checkpoint.snapshotHash, checkpoint.parentHash].filter((value) => value !== undefined))) {
    const child = Bun.spawn(
      [
        "git",
        "--git-dir",
        repository,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "cat-file",
        "-e",
        `${tree}^{tree}`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    if ((await child.exited) !== 0)
      throw new Error("Import checkpoint snapshot trees before importing checkpoint metadata")
  }
}

/** Offline only: the caller stops both runtimes and holds the central volume writer lock. */
export async function run(input: Input) {
  // The SQLite metadata importer consumes verifyTarget; defer the reverse dependency to this standalone operation.
  const { SQLiteImport } = await import("../database/postgres/import-sqlite")
  const sourceRoot = await fs.realpath(input.sourceDataRoot)
  const workspaceRoot = await fs.realpath(input.workspaceRoot)
  const targetRoot = await CentralStorage.resolveUnder(path.dirname(workspaceRoot), input.targetDataRoot)
  if (
    sourceRoot === targetRoot ||
    sourceRoot.startsWith(targetRoot + path.sep) ||
    targetRoot.startsWith(sourceRoot + path.sep)
  )
    throw new Error("Checkpoint source and destination roots must be disjoint")
  const source = await SQLiteImport.openSource(input.source)
  const stages: string[] = []
  const published: string[] = []
  try {
    const projects = new Set(
      source.database
        .query<{ id: string }, []>("select id from project")
        .all()
        .map((row) => row.id),
    )
    const metadataRoot = path.join(sourceRoot, "storage", "checkpoint")
    if ((await CentralStorage.resolveUnder(sourceRoot, metadataRoot)) !== metadataRoot)
      throw new Error("Checkpoint import refuses symlink paths")
    const entries = await fs.readdir(metadataRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const checkpoints = new Map<string, { value: Metadata; filename: string; sha256: string; mapped: Metadata }>()
    for (const project of entries) {
      if (!project.isDirectory() || !projects.has(project.name))
        throw new Error("Checkpoint storage references an unknown project or non-directory")
      const projectRoot = path.join(metadataRoot, project.name)
      await CentralStorage.resolveUnder(sourceRoot, projectRoot)
      for (const file of await fs.readdir(projectRoot, { withFileTypes: true })) {
        const filename = path.join(projectRoot, file.name)
        if (
          !file.isFile() ||
          !file.name.endsWith(".json") ||
          (await regular(sourceRoot, filename)).size > 32 * 1024 * 1024
        )
          throw new Error("Checkpoint metadata must be regular JSON files of at most 32 MiB")
        const content = await fs.readFile(filename, "utf8")
        const value = parse(json(content))
        if (value.projectID !== project.name || value.id !== file.name.slice(0, -5))
          throw new Error("Checkpoint metadata identifiers do not match the storage key")
        const worktree = await CentralStorage.resolveUnder(
          workspaceRoot,
          SQLiteImport.mapPath(value.worktree, input.paths),
        )
        if (!(await fs.stat(worktree)).isDirectory()) throw new Error("Copy checkpoint worktrees before importing")
        const mapped = { ...value, worktree }
        await absent(directory(targetRoot, mapped))
        checkpoints.set(`${value.projectID}/${value.id}`, {
          value,
          filename,
          sha256: createHash("sha256").update(content).digest("hex"),
          mapped,
        })
      }
    }
    const plans = []
    for (const checkpoint of checkpoints.values()) {
      const artifacts = []
      for (const artifact of checkpoint.value.database) {
        if (!artifact.exists) continue
        let owner = checkpoint
        const seen = new Set<string>()
        // Older versions omitted a new copy when database bytes were unchanged. Resolve only exact parent content.
        for (;;) {
          if (seen.has(owner.value.id)) throw new Error("Checkpoint artifact inheritance contains a cycle")
          seen.add(owner.value.id)
          const filename = path.join(directory(sourceRoot, owner.value), "database", artifact.path)
          const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          if (stat) {
            await verifyFile(sourceRoot, filename, artifact)
            artifacts.push({ path: artifact.path, source: filename, sha256: artifact.hash!, size: artifact.size! })
            break
          }
          const parent = owner.value.parentID
            ? checkpoints.get(`${owner.value.projectID}/${owner.value.parentID}`)
            : undefined
          const inherited = parent?.value.database.find((value) => value.path === artifact.path)
          if (
            !parent ||
            parent.value.worktree !== checkpoint.value.worktree ||
            !inherited?.exists ||
            inherited.hash !== artifact.hash ||
            inherited.size !== artifact.size
          )
            throw new Error("Referenced checkpoint artifact is missing; no identical parent artifact is available")
          owner = parent
        }
      }
      plans.push({ checkpoint, artifacts, destination: directory(targetRoot, checkpoint.mapped) })
    }
    if (input.apply) {
      const root = path.join(targetRoot, "checkpoint")
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      for (const plan of plans) {
        const stage = await fs.mkdtemp(path.join(root, ".import-"))
        stages.push(stage)
        for (const artifact of plan.artifacts) {
          const destination = path.join(stage, "database", artifact.path)
          await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
          await fs.copyFile(artifact.source, destination, fs.constants.COPYFILE_EXCL)
          await verifyFile(stage, destination, { ...artifact, hash: artifact.sha256, exists: true })
        }
        await fs.mkdir(path.dirname(plan.destination), { recursive: true, mode: 0o700 })
        await CentralStorage.resolveUnder(targetRoot, plan.destination)
        await absent(plan.destination)
        await fs.rename(stage, plan.destination)
        published.push(plan.destination)
      }
    }
    if ((await digest(input.source)) !== source.sha256)
      throw new Error("SQLite source changed during checkpoint import")
    for (const plan of plans) {
      if ((await digest(plan.checkpoint.filename)) !== plan.checkpoint.sha256)
        throw new Error("Checkpoint metadata changed during import")
      for (const artifact of plan.artifacts)
        await verifyFile(sourceRoot, artifact.source, { ...artifact, hash: artifact.sha256, exists: true })
    }
    return {
      sourceSha256: source.sha256,
      applied: input.apply === true,
      checkpointCount: plans.length,
      artifactCount: plans.reduce((total, plan) => total + plan.artifacts.length, 0),
      checkpoints: plans.map((plan) => ({
        projectID: plan.checkpoint.value.projectID,
        id: plan.checkpoint.value.id,
        source: plan.checkpoint.filename,
        metadataSha256: plan.checkpoint.sha256,
        worktree: plan.checkpoint.mapped.worktree,
        destination: plan.destination,
        artifacts: plan.artifacts,
      })),
    }
  } catch (cause) {
    for (const destination of published) await fs.rm(destination, { recursive: true, force: true })
    throw cause
  } finally {
    source.database.close()
    for (const stage of stages) await fs.rm(stage, { recursive: true, force: true })
  }
}
