import fs from "node:fs/promises"
import { constants } from "node:fs"
import { Effect } from "effect"
import { Database } from "../src/database/database"
import { DataKeyRotation } from "../src/database/postgres/rotate-data-key"
import { CentralStorage } from "../src/storage/central"
import { RotationLock } from "./lib/rotation-lock"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log(
    "bun run script/rotate-data-key.ts --from-key-file /secrets/old-key --to-key-file /secrets/new-key --database-url-file /secrets/migrator-url [--apply]\nStop the instance and all workspace processes first. Default is validation only. The command acquires the shared-volume and PostgreSQL runtime locks. After a successful --apply, update the deployment key secret before starting the instance. Retain the old key with older backups. Key files are never modified.",
  )
  process.exit(0)
}
const allowed = new Set(["--from-key-file", "--to-key-file", "--database-url-file", "--apply"])
const values = new Map<string, string>()
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (!allowed.has(flag) || values.has(flag)) throw new Error("Unknown or repeated rotation option")
  if (flag === "--apply") {
    values.set(flag, "true")
    continue
  }
  const value = args[++index]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
  values.set(flag, value)
}
const sourceFile = values.get("--from-key-file")
const targetFile = values.get("--to-key-file")
const databaseFile = values.get("--database-url-file")
const storage = CentralStorage.current()
const instanceID = process.env.OPENCODE_INSTANCE_ID
const schema = process.env.OPENCODE_DATABASE_SCHEMA
if (!sourceFile || !targetFile || !databaseFile || !storage || !instanceID || !schema) {
  throw new Error(
    "Explicit source/target key files, database URL file and central instance/storage/schema configuration are required",
  )
}

async function secretFile(filename: string) {
  const file = await fs.open(await fs.realpath(filename), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o007) !== 0) {
      throw new Error("Rotation secret files must be bounded regular files without world access")
    }
    return (await file.readFile("utf8")).trim()
  } finally {
    await file.close()
  }
}

await CentralStorage.check(storage)
const [source, target, url] = await Promise.all([
  secretFile(sourceFile),
  secretFile(targetFile),
  secretFile(databaseFile),
])
// Keep the kernel flock in a supervised child. No flag or environment variable
// can accidentally skip the lock; closing stdin releases it after completion.
const holder = await RotationLock.acquire(storage.root)
try {
  await CentralStorage.check(storage)
  const databaseLayer = (() => {
    try {
      return Database.layerFromConfig({ url, schema, instanceID, mode: "migration" })
    } catch {
      throw new Error("The migrator connection configuration is invalid")
    }
  })()
  const report = await Effect.runPromise(
    Database.Service.use(({ db }) =>
      DataKeyRotation.run(db, {
        source: { instanceID, secret: source },
        target: { instanceID, secret: target },
        apply: values.has("--apply"),
      }),
    ).pipe(
      Effect.raceFirst(
        Effect.promise(() => holder.exited).pipe(
          Effect.flatMap(() =>
            Effect.fail(new DataKeyRotation.RotationError({ operation: "filesystem-ownership-lost" })),
          ),
        ),
      ),
      Effect.provide(databaseLayer),
      Effect.scoped,
    ),
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  holder.stdin.end()
  await holder.exited
}
