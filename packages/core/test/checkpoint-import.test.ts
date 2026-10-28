import { afterEach, expect, test } from "bun:test"
import { $ } from "bun"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Service, layerFromConfig, configFromEnvironment } from "../src/database/database"
import { SQLiteImport } from "../src/database/postgres/import-sqlite"
import { InstanceStateEncryption } from "../src/instance-state/encryption"
import { InstanceStateTable } from "../src/instance-state/sql"
import { CheckpointImport } from "../src/storage/import-checkpoints"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
const hash = (value: string) => createHash("sha1").update(value).digest("hex")

async function fixture() {
  // Storage roots must not sit behind a symlink, and macOS's tmpdir is under
  // the /var -> /private/var link.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omai-checkpoint-import-")))
  roots.push(root)
  const source = path.join(root, "source.db")
  const database = new Database(source)
  database.exec(await Bun.file(new URL("fixture/sqlite-import.sql", import.meta.url)).text())
  database
    .query(
      "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project-fixture','/old/project',1,1,'[]')",
    )
    .run()
  database.close()
  const sourceDataRoot = path.join(root, "source-data")
  const workspaceRoot = path.join(root, "central", "workspaces")
  const targetDataRoot = path.join(root, "central", "data")
  const target = path.join(workspaceRoot, "project")
  await fs.mkdir(target, { recursive: true })
  await fs.mkdir(targetDataRoot, { recursive: true })
  const artifact = Buffer.from("offline sqlite checkpoint bytes\n")
  const sourceArtifact = path.join(
    sourceDataRoot,
    "checkpoint",
    "project-fixture",
    hash("/old/project"),
    "chk_original",
    "database",
    "data",
    "app.sqlite",
  )
  await fs.mkdir(path.dirname(sourceArtifact), { recursive: true })
  await fs.writeFile(sourceArtifact, artifact)
  const repository = path.join(targetDataRoot, "snapshot", "project-fixture", hash(target))
  await $`git init --bare ${repository}`.quiet()
  const tree = (await $`git --git-dir ${repository} mktree < /dev/null`.text()).trim()
  const metadata: CheckpointImport.Metadata = {
    id: "chk_original",
    projectID: "project-fixture",
    worktree: "/old/project",
    snapshotHash: tree,
    database: [
      {
        path: "data/app.sqlite",
        exists: true,
        size: artifact.length,
        hash: createHash("sha256").update(artifact).digest("hex"),
      },
      { path: "deleted.db", exists: false },
    ],
  }
  const metadataRoot = path.join(sourceDataRoot, "storage", "checkpoint", "project-fixture")
  await fs.mkdir(metadataRoot, { recursive: true })
  const save = (value: CheckpointImport.Metadata) =>
    fs.writeFile(path.join(metadataRoot, `${value.id}.json`), JSON.stringify(value))
  await save(metadata)
  await save({ ...metadata, id: "chk_inherited", parentID: metadata.id })
  const input: CheckpointImport.Input = {
    source,
    sourceDataRoot,
    workspaceRoot,
    targetDataRoot,
    paths: [{ from: "/old", to: workspaceRoot }],
  }
  return { source, sourceArtifact, metadata, metadataRoot, save, input, target, artifact }
}

test("checkpoint import verifies dry-run, materializes inherited bytes and preserves IDs under remapped worktrees", async () => {
  const value = await fixture()
  const before = await fs.readFile(value.sourceArtifact)
  const dry = await CheckpointImport.run(value.input)
  expect(dry.applied).toBe(false)
  expect(dry.checkpointCount).toBe(2)
  expect(dry.artifactCount).toBe(2)
  expect(await fs.exists(path.join(value.input.targetDataRoot, "checkpoint"))).toBe(false)
  const report = await CheckpointImport.run({ ...value.input, apply: true })
  expect(report.sourceSha256).toBe(
    createHash("sha256")
      .update(await fs.readFile(value.source))
      .digest("hex"),
  )
  expect(report.checkpoints.map((row) => row.id).sort()).toEqual(["chk_inherited", "chk_original"])
  for (const checkpoint of report.checkpoints) {
    expect(checkpoint.worktree).toBe(value.target)
    expect(checkpoint.destination).toContain(hash(value.target))
    expect(await fs.readFile(path.join(checkpoint.destination, "database", "data", "app.sqlite"))).toEqual(
      value.artifact,
    )
    await CheckpointImport.verifyTarget(
      { ...value.metadata, id: checkpoint.id, worktree: value.target },
      value.input.targetDataRoot,
    )
  }
  expect(await fs.readFile(value.sourceArtifact)).toEqual(before)
  await fs.rm(value.input.sourceDataRoot, { recursive: true })
  await CheckpointImport.verifyTarget(
    { ...value.metadata, id: "chk_inherited", worktree: value.target },
    value.input.targetDataRoot,
  )
})

test("checkpoint import fails closed for corruption, missing inherited bytes, and existing destinations", async () => {
  const corrupt = await fixture()
  await fs.writeFile(corrupt.sourceArtifact, "changed")
  await expect(CheckpointImport.run({ ...corrupt.input, apply: true })).rejects.toThrow("SHA-256")
  expect(await fs.exists(path.join(corrupt.input.targetDataRoot, "checkpoint"))).toBe(false)
  const missing = await fixture()
  await fs.rm(missing.sourceArtifact)
  await expect(CheckpointImport.run(missing.input)).rejects.toThrow("no identical parent")
  const existing = await fixture()
  const report = await CheckpointImport.run({ ...existing.input, apply: true })
  await expect(CheckpointImport.run({ ...existing.input, apply: true })).rejects.toThrow("never overwrites")
  expect(await fs.readFile(path.join(report.checkpoints[0].destination, "database", "data", "app.sqlite"))).toEqual(
    existing.artifact,
  )
})

test("checkpoint import rejects symlinks and unsafe artifact metadata", async () => {
  const value = await fixture()
  await fs.rename(value.sourceArtifact, value.sourceArtifact + ".original")
  await fs.symlink(value.sourceArtifact + ".original", value.sourceArtifact)
  await expect(CheckpointImport.run(value.input)).rejects.toThrow("symlink")
  expect(() =>
    CheckpointImport.parse({ ...value.metadata, database: [{ ...value.metadata.database[0], path: "../escape.db" }] }),
  ).toThrow("unsafe")
  expect(() => CheckpointImport.parse({ ...value.metadata, database: [{ path: "data.db", exists: true }] })).toThrow(
    "SHA-256",
  )
  await value.save({ ...value.metadata, id: "chk_inherited", parentID: "chk_inherited" })
  await expect(CheckpointImport.run(value.input)).rejects.toThrow("cycle")
})

test("checkpoint metadata cannot be published before copied artifacts and snapshot trees are verified", async () => {
  const value = await fixture()
  await expect(
    CheckpointImport.verifyTarget({ ...value.metadata, worktree: value.target }, value.input.targetDataRoot),
  ).rejects.toThrow()
  await CheckpointImport.run({ ...value.input, apply: true })
  await expect(
    CheckpointImport.verifyTarget(
      { ...value.metadata, worktree: value.target, snapshotHash: "a".repeat(40) },
      value.input.targetDataRoot,
    ),
  ).rejects.toThrow("snapshot trees")
})

test("complete checkpoint migration publishes remapped encrypted PostgreSQL metadata with independently restorable artifacts", async () => {
  const value = await fixture()
  const artifacts = await CheckpointImport.run({ ...value.input, apply: true })
  const encryption = InstanceStateEncryption.keyFromEnvironment()
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Service
      const report = yield* SQLiteImport.run(database.db, {
        source: value.source,
        dataDirectory: value.input.sourceDataRoot,
        targetDataRoot: value.input.targetDataRoot,
        workspaceRoot: value.input.workspaceRoot,
        paths: value.input.paths,
        encryption,
        apply: true,
      })
      const states = yield* database.db.select().from(InstanceStateTable)
      return { report, states }
    }).pipe(Effect.provide(layerFromConfig(configFromEnvironment())), Effect.scoped),
  )
  expect(result.report.sha256).toBe(artifacts.sourceSha256)
  expect(result.report.metadataCount).toBe(2)
  await fs.rm(value.input.sourceDataRoot, { recursive: true })
  const codec = InstanceStateEncryption.codec(encryption)
  const states = result.states.filter((row) => row.namespace === "legacy-storage")
  expect(states).toHaveLength(2)
  for (const state of states) {
    const checkpoint = CheckpointImport.parse(codec.decode(state.namespace, state.key, state.value))
    expect(checkpoint.worktree).toBe(value.target)
    expect(checkpoint.database).toEqual(value.metadata.database)
    await CheckpointImport.verifyTarget(checkpoint, value.input.targetDataRoot)
  }
})
