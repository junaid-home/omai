import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { connectionURLFromEnvironment, layerFromConfig, Service } from "../src/database/database"
import { SQLiteImport } from "../src/database/postgres/import-sqlite"
import { InstanceStateEncryption } from "../src/instance-state/encryption"
import { CentralStorage } from "../src/storage/central"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log(
    "bun run script/import-sqlite.ts --source /offline/omai.db --path-map /offline/paths.json [--data-directory /offline/data] [--apply]\nDefault: read-only validation. Target must already be migrated and empty; both runtimes must be stopped. File copying is a separate operator step.",
  )
  process.exit(0)
}
const flags = new Set(["--source", "--path-map", "--data-directory", "--apply"])
const values = new Map<string, string>()
for (let index = 0; index < args.length; index++) {
  const key = args[index]
  if (!flags.has(key) || values.has(key)) throw new Error("Unknown or repeated import option")
  if (key === "--apply") {
    values.set(key, "true")
    continue
  }
  const value = args[++index]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
  values.set(key, value)
}
const source = values.get("--source")
const mapping = values.get("--path-map")
const workspaceRoot = CentralStorage.workspaceRoot()
const storage = CentralStorage.current()
const instanceID = process.env.OPENCODE_INSTANCE_ID
const schema = process.env.OPENCODE_DATABASE_SCHEMA
if (!source || !mapping || !workspaceRoot || !storage || !instanceID || !schema)
  throw new Error("--source, --path-map and central storage/instance/schema configuration are required")
await CentralStorage.check()
const paths = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))),
)(await fs.readFile(mapping, "utf8"))
const program = Effect.gen(function* () {
  const { db } = yield* Service
  return yield* SQLiteImport.run(db, {
    source,
    workspaceRoot,
    paths,
    dataDirectory: values.get("--data-directory"),
    targetDataRoot: path.join(storage.root, "data"),
    encryption: InstanceStateEncryption.keyFromEnvironment(),
    apply: values.has("--apply"),
  })
})
const url = connectionURLFromEnvironment("OPENCODE_DATABASE_MIGRATOR_URL")
const report = await Effect.runPromise(
  program.pipe(Effect.provide(layerFromConfig({ url, instanceID, schema, mode: "migration" })), Effect.scoped),
)
console.log(JSON.stringify(report, null, 2))
