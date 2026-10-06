import { afterEach, expect, test } from "bun:test"
import { $ } from "bun"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SnapshotImport } from "../src/storage/import-snapshots"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
const hash = (value: string) => createHash("sha1").update(value).digest("hex")

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omai-snapshot-import-"))
  roots.push(root)
  const worktree = path.join(root, "old-project")
  const sourceRoot = path.join(root, "source-snapshots")
  const snapshot = path.join(sourceRoot, "project-fixture", hash(worktree))
  const workspaceRoot = path.join(root, "central", "workspaces")
  const target = path.join(workspaceRoot, "project")
  const targetRoot = path.join(root, "central", "data", "snapshot")
  const destination = path.join(targetRoot, "project-fixture", hash(target))
  await fs.mkdir(worktree, { recursive: true })
  await fs.mkdir(target, { recursive: true })
  await $`git init ${worktree}`.quiet()
  await fs.writeFile(path.join(worktree, "example.txt"), "original contents\n")
  await $`git -C ${worktree} add example.txt`.quiet()
  await $`git -C ${worktree} -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -m fixture`.quiet()
  await $`git init --bare ${snapshot}`.quiet()
  await fs.copyFile(path.join(worktree, ".git", "index"), path.join(snapshot, "index"))
  const alternates = path.join(snapshot, "objects", "info", "alternates")
  await fs.writeFile(alternates, path.join(worktree, ".git", "objects") + "\n")
  const tree = (await $`git --git-dir ${snapshot} --work-tree ${worktree} write-tree`.text()).trim()
  const source = path.join(root, "source.db")
  const database = new Database(source)
  database.exec(await Bun.file(new URL("fixture/sqlite-import.sql", import.meta.url)).text())
  database
    .query(
      "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project-fixture',?,1,1,'[]')",
    )
    .run(worktree)
  database
    .query(
      "INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated,revert) VALUES ('ses_fixture','project-fixture','fixture',?,'Fixture','1',1,1,?)",
    )
    .run(worktree, JSON.stringify({ snapshot: tree }))
  database
    .query(
      "INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES ('msg_fixture','ses_fixture','assistant',1,1,1,?)",
    )
    .run(JSON.stringify({ snapshot: { start: tree, end: tree } }))
  database.close()
  const input: SnapshotImport.Input = {
    source,
    sourceRoot,
    targetRoot,
    workspaceRoot,
    worktrees: [{ projectID: "project-fixture", from: worktree, to: target }],
  }
  return { root, source, snapshot, worktree, target, destination, alternates, tree, input }
}

test("snapshot dry-run verifies references without changing source or creating a destination", async () => {
  const input = await fixture()
  const before = await fs.readFile(input.alternates, "utf8")
  const report = await SnapshotImport.run(input.input)
  expect(report.applied).toBe(false)
  expect(report.referencedTrees).toBe(1)
  expect(report.repositories[0].destination).toBe(input.destination)
  expect(await fs.readFile(input.alternates, "utf8")).toBe(before)
  expect(await fs.exists(input.input.targetRoot)).toBe(false)
})

test("snapshot import relocates hashes and retains undo after source deletion and destination GC", async () => {
  const input = await fixture()
  const before = await fs.readFile(input.alternates, "utf8")
  const sourceHash = createHash("sha256")
    .update(await fs.readFile(input.source))
    .digest("hex")
  const report = await SnapshotImport.run({ ...input.input, apply: true })
  expect(report.sourceSha256).toBe(sourceHash)
  expect(await fs.readFile(input.alternates, "utf8")).toBe(before)
  expect(await fs.exists(path.join(input.destination, "objects", "info", "alternates"))).toBe(false)
  expect(
    (await $`git --git-dir ${input.destination} rev-parse refs/opencode/snapshots/${input.tree}`.text()).trim(),
  ).toBe(input.tree)
  await fs.rm(input.worktree, { recursive: true })
  await fs.rm(input.input.sourceRoot, { recursive: true })
  await $`git --git-dir ${input.destination} gc --prune=now`.quiet()
  await $`git --git-dir ${input.destination} fsck --full --no-dangling`.quiet()
  await $`git --git-dir ${input.destination} --work-tree ${input.target} read-tree ${input.tree}`.quiet()
  await $`git --git-dir ${input.destination} --work-tree ${input.target} checkout-index -a -f`.quiet()
  expect(await fs.readFile(path.join(input.target, "example.txt"), "utf8")).toBe("original contents\n")
  expect((await $`git --git-dir ${input.destination} --work-tree ${input.target} write-tree`.text()).trim()).toBe(
    input.tree,
  )
})

test("snapshot migration refuses missing trees and existing destinations", async () => {
  const missing = await fixture()
  const db = new Database(missing.source)
  db.query("UPDATE session SET revert=?").run(JSON.stringify({ snapshot: "a".repeat(40) }))
  db.close()
  await expect(SnapshotImport.run({ ...missing.input, apply: true })).rejects.toThrow(
    "Referenced snapshot tree is unavailable",
  )
  expect(await fs.exists(missing.input.targetRoot)).toBe(false)
  const existing = await fixture()
  await fs.mkdir(existing.destination, { recursive: true })
  await expect(SnapshotImport.run({ ...existing.input, apply: true })).rejects.toThrow("never overwrites")
})

test("snapshot migration refuses missing alternates and unlisted repositories", async () => {
  const input = await fixture()
  await fs.rename(path.join(input.worktree, ".git", "objects"), path.join(input.root, "archived-objects"))
  await expect(SnapshotImport.run(input.input)).rejects.toThrow()
  const options = {
    ...input.input,
    objects: [{ from: path.join(input.worktree, ".git", "objects"), to: path.join(input.root, "archived-objects") }],
  }
  const report = await SnapshotImport.run(options)
  expect(report.referencedTrees).toBe(1)
  await fs.mkdir(path.join(input.input.sourceRoot, "project-fixture", "unmapped"))
  await expect(SnapshotImport.run(options)).rejects.toThrow("explicit worktree mapping")
})
