import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { CentralStorage } from "../src/storage/central"
import { CheckpointImport } from "../src/storage/import-checkpoints"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log(
    "bun run script/import-checkpoints.ts --source /import/omai.db --data-directory /import/data --path-map /import/paths.json [--apply]\nDefault: verify checkpoint metadata and every artifact without writing. Stop both instances and hold the central volume runtime lock. Imports complete checkpoint artifacts under remapped worktree hashes; existing destinations are never overwritten. Import Git snapshots separately before the final database import.",
  )
  process.exit(0)
}
const allowed = new Set(["--source", "--data-directory", "--path-map", "--apply"])
const values = new Map<string, string>()
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (!allowed.has(flag) || values.has(flag)) throw new Error("Unknown or repeated checkpoint import option")
  if (flag === "--apply") {
    values.set(flag, "true")
    continue
  }
  const value = args[++index]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
  values.set(flag, value)
}
const source = values.get("--source")
const sourceDataRoot = values.get("--data-directory")
const mapping = values.get("--path-map")
const storage = CentralStorage.current()
const workspaceRoot = CentralStorage.workspaceRoot()
if (!source || !sourceDataRoot || !mapping || !storage || !workspaceRoot)
  throw new Error("Source SQLite, data directory, path map and central storage configuration are required")
await CentralStorage.check(storage)
const paths = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))),
)(await fs.readFile(mapping, "utf8"))
console.log(
  JSON.stringify(
    await CheckpointImport.run({
      source,
      sourceDataRoot,
      targetDataRoot: path.join(storage.root, "data"),
      workspaceRoot,
      paths,
      apply: values.has("--apply"),
    }),
    null,
    2,
  ),
)
