export * as SQLiteImport from "./import-sqlite"

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { getTableColumns, getTableName, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { claimRuntime, type Client } from "../database"
import { sourceTables, sourceMigrations } from "./sqlite-source"
import { PostgreSQLMigration } from "./migration"
import { InstanceStateEncryption } from "../../instance-state/encryption"
import { InstanceStateTable } from "../../instance-state/sql"
import { CentralStorage } from "../../storage/central"
import { CheckpointImport } from "../../storage/import-checkpoints"
import { AccountTable, AccountStateTable, ControlAccountTable } from "../../account/sql"
import { ProjectTable, ProjectDirectoryTable } from "../../project/sql"
import { WorkspaceTable } from "../../control-plane/workspace.sql"
import { EventSequenceTable, EventTable } from "../../event/sql"
import { CredentialTable } from "../../credential/sql"
import { DataMigrationTable } from "../../data-migration.sql"
import { PermissionTable } from "../../permission/sql"
import {
  SessionTable,
  MessageTable,
  PartTable,
  TodoTable,
  SessionMessageTable,
  SessionInputTable,
  SessionContextEpochTable,
} from "../../session/sql"
import { SessionShareTable } from "../../share/sql"
import { PublishDeploymentTable } from "../../publish/sql"
import { UserTable } from "../../user/sql"
import { UserStateTable } from "../../user-state/sql"
import { AuthSessionTable } from "../../auth-session/sql"

const tables = [
  AccountTable,
  AccountStateTable,
  ControlAccountTable,
  CredentialTable,
  DataMigrationTable,
  ProjectTable,
  ProjectDirectoryTable,
  WorkspaceTable,
  EventSequenceTable,
  EventTable,
  PermissionTable,
  SessionTable,
  MessageTable,
  PartTable,
  TodoTable,
  SessionMessageTable,
  SessionInputTable,
  SessionContextEpochTable,
  SessionShareTable,
  PublishDeploymentTable,
  UserTable,
] as const

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
type Row = Record<string, unknown>

export interface PathMapping {
  readonly from: string
  readonly to: string
}

export interface Options {
  readonly source: string
  /** A stopped, checkpointed source is required. WAL sidecars are never silently ignored. */
  readonly dataDirectory?: string
  /** Required when importing legacy checkpoints; artifacts must be migrated first. */
  readonly targetDataRoot?: string
  readonly workspaceRoot: string
  readonly paths: ReadonlyArray<PathMapping>
  readonly encryption: InstanceStateEncryption.Key
  readonly apply?: boolean
}

export interface Report {
  readonly source: string
  readonly sha256: string
  readonly baseline: "opencode-11-20260924"
  readonly applied: boolean
  readonly counts: Record<string, number>
  readonly metadataCount: number
  readonly pathMappings: ReadonlyArray<PathMapping>
  readonly sourceJournals: ReadonlyArray<string>
}

interface Source {
  readonly database: Database
  readonly sha256: string
  readonly journals: Record<string, Row[]>
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const digest = async (filename: string) => {
  const hash = createHash("sha256")
  for await (const bytes of Bun.file(filename).stream()) hash.update(bytes)
  return hash.digest("hex")
}

function normalize(input: string) {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"))
  return /^[A-Za-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/$/, "") || "/"
}

const absolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:\//.test(value)

export function mapPath(value: unknown, mappings: ReadonlyArray<PathMapping>) {
  if (typeof value !== "string") throw new Error("Stored filesystem path must be text")
  if (!value) return value
  const input = normalize(value)
  if (!absolute(input)) throw new Error("Source contains a non-absolute workspace directory")
  const matches = mappings
    .filter((item) => input === normalize(item.from) || input.startsWith(normalize(item.from).replace(/\/$/, "") + "/"))
    .toSorted((left, right) => normalize(right.from).length - normalize(left.from).length)
  if (!matches.length) throw new Error("Source workspace path has no explicit migration mapping")
  return path.resolve(matches[0].to, path.posix.relative(normalize(matches[0].from), input))
}

async function checkpointed(filename: string) {
  for (const suffix of ["-wal", "-journal"]) {
    const sidecar = await fs.stat(filename + suffix).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (sidecar && sidecar.size > 0)
      throw new Error("Stop and checkpoint SQLite, then create an offline backup without a WAL or rollback journal")
  }
}

export async function openSource(filename: string): Promise<Source> {
  if (!(await fs.lstat(filename)).isFile()) throw new Error("SQLite import source must be a regular file")
  await checkpointed(filename)
  const sha256 = await digest(filename)
  const database = new Database(filename, { readonly: true, create: false, safeIntegers: true })
  try {
    database.exec("PRAGMA query_only = ON; BEGIN")
    const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      throw new Error("SQLite integrity check failed")
    if (database.query("PRAGMA foreign_key_check").all().length)
      throw new Error("SQLite foreign-key integrity check failed")
    if (database.query("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view')").all().length)
      throw new Error("SQLite source contains unsupported triggers or views")
    const found = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    const expected = Object.keys(sourceTables)
    if (
      expected.some((name) => !found.includes(name)) ||
      found.some((name) => !expected.includes(name) && name !== "__drizzle_migrations")
    )
      throw new Error("Unsupported SQLite table set; upgrade the source with its original application before exporting")
    for (const [name, columns] of Object.entries(sourceTables)) {
      const actual = database.query<{ name: string; type: string }, []>(`PRAGMA table_xinfo(${quote(name)})`).all()
      if (
        actual.length !== columns.length ||
        columns.some(
          (column) => !actual.some((item) => item.name === column.name && item.type.toUpperCase() === column.type),
        )
      )
        throw new Error(`Unsupported SQLite columns in ${name}; no columns are discarded or synthesized`)
    }
    const completed = database
      .query<{ id: string }, []>("SELECT id FROM migration ORDER BY id")
      .all()
      .map((row) => row.id)
    if (completed.length !== sourceMigrations.length || sourceMigrations.some((id) => !completed.includes(id)))
      throw new Error("SQLite migration journal does not match the supported frozen baseline")
    const journals = Object.fromEntries(
      found
        .filter((name) => name === "migration" || name === "__drizzle_migrations")
        .map((name) => [
          name,
          database
            .query<Row, []>(`SELECT * FROM ${quote(name)}`)
            .all()
            .map(normalizeIntegers),
        ]),
    )
    return { database, sha256, journals }
  } catch (cause) {
    database.close()
    throw cause
  }
}

function normalizeIntegers(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value !== "bigint") return [key, value]
      const converted = Number(value)
      if (!Number.isSafeInteger(converted)) throw new Error("SQLite integer exceeds the supported safe integer range")
      return [key, converted]
    }),
  )
}

function transform(
  table: (typeof tables)[number],
  source: Row,
  mappings: ReadonlyArray<PathMapping>,
  moved: Set<string>,
) {
  const move = (value: unknown) => {
    const result = mapPath(value, mappings)
    if (result) moved.add(result)
    return result
  }
  const row = normalizeIntegers(source)
  const name = getTableName(table)
  for (const column of sourceTables[name]) {
    const value = row[column.name]
    if (value === null) continue
    if (
      (column.type === "TEXT" && typeof value !== "string") ||
      (column.type === "INTEGER" && (typeof value !== "number" || !Number.isSafeInteger(value))) ||
      (column.type === "REAL" && (typeof value !== "number" || !Number.isFinite(value)))
    )
      throw new Error(`Invalid SQLite value type in ${name}.${column.name}`)
  }
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    const value = row[key]
    if (value === null) {
      if (column.notNull || column.primary) throw new Error(`Source contains null in required ${name}.${key}`)
      continue
    }
    if (
      column.getSQLType() === "jsonb" ||
      (name === "credential" && key === "value") ||
      (name === "project" && key === "sandboxes")
    ) {
      if (typeof value !== "string") throw new Error(`Invalid JSON source type in ${name}.${key}`)
      row[key] = decodeJson(value)
    }
    if (column.dataType === "boolean") {
      if (value !== 0 && value !== 1) throw new Error(`Invalid boolean source value in ${name}.${key}`)
      row[key] = value === 1
    }
  }
  if (name === "project") {
    row.worktree = move(row.worktree)
    if (!Array.isArray(row.sandboxes)) throw new Error("Project sandboxes must be an array")
    row.sandboxes = row.sandboxes.map(move)
  }
  if (name === "project_directory" || name === "session" || name === "workspace") {
    if (row.directory !== null) row.directory = move(row.directory)
    if (typeof row.path === "string" && absolute(normalize(row.path))) row.path = move(row.path)
  }
  // Rewrite only placement fields used by replay, never transcript text or arbitrary tool payloads.
  if (name === "event" && row.data && typeof row.data === "object" && !Array.isArray(row.data)) {
    const data = row.data as Row
    const info = data.info
    if (
      (row.type === "session.created" || row.type === "session.updated") &&
      info &&
      typeof info === "object" &&
      !Array.isArray(info)
    ) {
      const session = info as Row
      session.directory = move(session.directory)
      if (typeof session.path === "string" && absolute(normalize(session.path))) session.path = move(session.path)
    }
    if (
      row.type === "session.next.moved" &&
      data.location &&
      typeof data.location === "object" &&
      !Array.isArray(data.location)
    ) {
      const location = data.location as Row
      location.directory = move(location.directory)
    }
  }
  return row
}

async function metadata(options: Options, mappings: ReadonlyArray<PathMapping>) {
  const result: { namespace: string; key: string; value: unknown; filename: string; sha256: string }[] = []
  const directory = options.dataDirectory
  if (!directory) return result
  const root = await fs.realpath(directory)
  const add = async (filename: string, namespace: string, key: string) => {
    const stat = await fs.lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw new Error("Metadata import requires regular JSON files of at most 32 MiB")
    const content = await fs.readFile(filename, "utf8")
    const decoded = decodeJson(content)
    const value = await (async () => {
      if (namespace !== "legacy-storage") return decoded
      const keys = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(key)
      if (keys[0] !== "checkpoint") return decoded
      const checkpoint = CheckpointImport.parse(decoded)
      if (keys.length !== 3 || keys[1] !== checkpoint.projectID || keys[2] !== checkpoint.id)
        throw new Error("Checkpoint metadata identity does not match its storage key")
      if (!options.targetDataRoot || !path.isAbsolute(options.targetDataRoot))
        throw new Error("Checkpoint metadata requires an explicit target data root and completed artifact import")
      const worktree = await CentralStorage.resolveUnder(options.workspaceRoot, mapPath(checkpoint.worktree, mappings))
      if (!(await fs.stat(worktree)).isDirectory()) throw new Error("Copy checkpoint worktrees before metadata import")
      const mapped = { ...(decoded as Row), worktree }
      await CheckpointImport.verifyTarget(mapped, options.targetDataRoot)
      return mapped
    })()
    result.push({
      namespace,
      key,
      value,
      filename,
      sha256: createHash("sha256").update(content).digest("hex"),
    })
  }
  for (const [filename, namespace] of [
    ["auth.json", "provider-auth"],
    ["mcp-auth.json", "mcp-auth"],
  ]) {
    const file = path.join(root, filename)
    const present = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (present) await add(file, namespace, "all")
  }
  const storage = path.join(root, "storage")
  const queue = [storage]
  while (queue.length) {
    const directory = queue.shift()!
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (directory === storage && error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) continue
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Metadata import refuses symlink directories")
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (directory === storage && error.code === "ENOENT") return []
      throw error
    })
    for (const entry of entries) {
      const filename = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error("Metadata import refuses symlinks")
      if (entry.isDirectory()) {
        queue.push(filename)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".json"))
        throw new Error("Unsupported file in legacy metadata storage")
      const key = path.relative(storage, filename).slice(0, -5).split(path.sep)
      await add(filename, "legacy-storage", JSON.stringify(key))
    }
  }
  return result
}

/** Import runs as one offline transaction and never invokes historical source migrations or project code. */
export const run = Effect.fn("SQLiteImport.run")(function* (db: Client, options: Options) {
  const encryption = InstanceStateEncryption.codec(options.encryption)
  const configured = InstanceStateEncryption.keyFromEnvironment()
  if (configured.instanceID !== options.encryption.instanceID || configured.secret !== options.encryption.secret)
    return yield* Effect.die("Importer and database codecs must use the same instance encryption key")
  if (!options.paths.length)
    return yield* Effect.die("At least one explicit source-to-workspace path mapping is required")
  if (options.paths.some((item) => !path.isAbsolute(item.to)))
    return yield* Effect.die("Path mapping destinations must be absolute central workspace paths")
  const paths = options.paths.map((item) => ({ from: normalize(item.from), to: path.resolve(item.to) }))
  if (paths.some((item) => !absolute(item.from)) || new Set(paths.map((item) => item.from)).size !== paths.length)
    return yield* Effect.die("Path mapping sources must be unique absolute prefixes")
  for (const mapping of paths)
    yield* Effect.promise(() => CentralStorage.resolveUnder(options.workspaceRoot, mapping.to))
  const source = yield* Effect.acquireRelease(
    Effect.promise(() => openSource(options.source)),
    (input) => Effect.sync(() => input.database.close()),
  )
  const files = yield* Effect.promise(() => metadata(options, paths))
  const ownership = yield* claimRuntime(db, options.encryption.instanceID)
  yield* PostgreSQLMigration.assertMigrated(db, { instanceID: options.encryption.instanceID })
  const counts: Record<string, number> = {}
  const report: Report = {
    source: options.source,
    sha256: source.sha256,
    baseline: "opencode-11-20260924",
    applied: options.apply === true,
    counts,
    metadataCount: files.length,
    pathMappings: paths,
    sourceJournals: Object.keys(source.journals),
  }
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        yield* db.execute(sql`set local statement_timeout = '10min'`)
        const all = [...tables, InstanceStateTable, UserStateTable, AuthSessionTable]
        if (options.apply)
          yield* db.execute(
            sql`lock table ${sql.join(
              all.map((table) => sql`${table}`),
              sql`, `,
            )} in access exclusive mode`,
          )
        for (const table of all) {
          const count = yield* db.execute<{ count: string }>(sql`select count(*)::text as count from ${table}`)
          if (count[0]?.count !== "0")
            return yield* Effect.die(
              `Target table ${getTableName(table)} is not empty; import will not merge or overwrite data`,
            )
        }
        for (const table of tables) {
          const name = getTableName(table)
          const columns = Object.entries(getTableColumns(table))
          const expected = sourceTables[name]
          if (
            columns.length !== expected.length ||
            columns.some(
              ([key, column]) => key !== column.name || !expected.some((source) => source.name === column.name),
            )
          )
            return yield* Effect.die(`Importer target columns changed in ${name}; update the explicit import contract`)
          const statement = source.database.query<Row, []>(`SELECT * FROM ${quote(name)}`)
          let count = 0
          let batch: Row[] = []
          const flush = () =>
            db.execute(
              sql`insert into ${table} (${sql.join(
                columns.map(([, column]) => sql.identifier(column.name)),
                sql`, `,
              )}) values ${sql.join(
                batch.map(
                  (row) =>
                    sql`(${sql.join(
                      columns.map(([key, column]) => sql.param(row[key], column)),
                      sql`, `,
                    )})`,
                ),
                sql`, `,
              )}`,
            )
          for (const value of statement.iterate()) {
            const moved = new Set<string>()
            const row = transform(table, value, paths, moved)
            for (const directory of moved)
              yield* Effect.promise(() => CentralStorage.resolveUnder(options.workspaceRoot, directory))
            // Validate through the same Drizzle codecs during dry-run, including encrypted columns.
            for (const [key, column] of columns) if (row[key] !== null) column.mapToDriverValue(row[key])
            if (name === "project" || name === "project_directory") {
              const directory = name === "project" ? row.worktree : row.directory
              yield* Effect.promise(async () => {
                const resolved = await CentralStorage.resolveUnder(options.workspaceRoot, String(directory))
                if (!(await fs.stat(resolved)).isDirectory())
                  throw new Error("Copy and verify project directories before importing metadata")
              })
            }
            count++
            if (!options.apply) continue
            batch.push(row)
            if (batch.length === 250) {
              yield* flush()
              batch = []
            }
          }
          if (batch.length) yield* flush()
          counts[name] = count
          if (options.apply) {
            const actual = yield* db.execute<{ count: string }>(sql`select count(*)::text as count from ${table}`)
            if (actual[0]?.count !== String(count)) return yield* Effect.die(`Imported row count mismatch in ${name}`)
          }
        }
        if ((yield* Effect.promise(() => digest(options.source))) !== source.sha256)
          return yield* Effect.die("SQLite source changed during import; transaction rolled back")
        yield* Effect.promise(() => checkpointed(options.source))
        for (const file of files) {
          if ((yield* Effect.promise(() => digest(file.filename))) !== file.sha256)
            return yield* Effect.die("Source metadata changed during import; transaction rolled back")
        }
        if (options.apply) {
          for (const item of [
            ...files,
            { namespace: "sqlite-import", key: source.sha256, value: { ...report, journals: source.journals } },
          ]) {
            yield* db.insert(InstanceStateTable).values({
              namespace: item.namespace,
              key: item.key,
              value: encryption.encode(item.namespace, item.key, item.value),
              revision: 1,
              time_updated: Date.now(),
            })
          }
          yield* db
            .insert(DataMigrationTable)
            .values({ name: `sqlite-import/${source.sha256}`, time_completed: Date.now() })
        }
        return report
      }),
    )
    .pipe(Effect.raceFirst(ownership.lost))
})
