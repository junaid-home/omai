import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { CentralStorage } from "../src/storage/central"
import { SnapshotImport } from "../src/storage/import-snapshots"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log(
    "bun run script/import-snapshots.ts --source /import/omai.db --source-root /import/data/snapshot --worktree-map /import/worktrees.json [--object-map /import/objects.json] [--apply]\nDefault: validate without changing the source or destination. Stop both instances and hold the central volume runtime lock. Worktree mappings contain projectID, from (exact old canonical worktree), and to (copied central worktree). Object mappings contain from/to for relocated offline Git object stores. Every snapshot repository must be mapped; existing destinations are never overwritten.",
  )
  process.exit(0)
}
const allowed = new Set(["--source", "--source-root", "--worktree-map", "--object-map", "--apply"])
const values = new Map<string, string>()
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (!allowed.has(flag) || values.has(flag)) throw new Error("Unknown or repeated snapshot import option")
  if (flag === "--apply") {
    values.set(flag, "true")
    continue
  }
  const value = args[++index]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
  values.set(flag, value)
}
const source = values.get("--source")
const sourceRoot = values.get("--source-root")
const mapping = values.get("--worktree-map")
const storage = CentralStorage.current()
const workspaceRoot = CentralStorage.workspaceRoot()
if (!source || !sourceRoot || !mapping || !storage || !workspaceRoot)
  throw new Error("Source SQLite, source snapshot root, worktree map and central storage configuration are required")
await CentralStorage.check(storage)
const worktrees = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ projectID: Schema.String, from: Schema.String, to: Schema.String })),
  ),
)(await fs.readFile(mapping, "utf8"))
const objectFile = values.get("--object-map")
const objects = objectFile
  ? Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))),
    )(await fs.readFile(objectFile, "utf8"))
  : undefined
const report = await SnapshotImport.run({
  source,
  sourceRoot,
  workspaceRoot,
  targetRoot: path.join(storage.root, "data", "snapshot"),
  worktrees,
  objects,
  apply: values.has("--apply"),
})
console.log(JSON.stringify(report, null, 2))
