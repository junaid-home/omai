import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { SQL } from "bun"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Service, configFromEnvironment, layerFromConfig } from "../src/database/database"
import { SQLiteImport } from "../src/database/postgres/import-sqlite"
import { InstanceStateEncryption } from "../src/instance-state/encryption"
import { AccountTable } from "../src/account/sql"
import { CredentialTable } from "../src/credential/sql"
import { ProjectTable } from "../src/project/sql"
import { EventTable } from "../src/event/sql"
import { InstanceStateTable } from "../src/instance-state/sql"
import { SessionTable } from "../src/session/sql"
import { schemaName } from "../src/database/schema.sql"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

const run = <A, E>(program: Effect.Effect<A, E, Service | Scope.Scope>) =>
  Effect.runPromise(program.pipe(Effect.provide(layerFromConfig(configFromEnvironment())), Effect.scoped))

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omai-sqlite-import-"))
  roots.push(root)
  const source = path.join(root, "source.db")
  const database = new Database(source)
  database.exec(await Bun.file(new URL("fixture/sqlite-import.sql", import.meta.url)).text())
  database.exec(`
    INSERT INTO account VALUES ('acc_fixture', 'fixture@example.invalid', 'https://example.invalid', 'access-secret', 'refresh-secret', 1700000010000, 1700000000000, 1700000000001);
    INSERT INTO credential VALUES ('cre_fixture', NULL, 'fixture', '{"type":"api","key":"credential-secret"}', NULL, NULL, 1, 1700000000000, 1700000000001);
    INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES ('project-fixture', '/legacy/project', 'git', 1700000000000, 1700000000001, '[]');
    INSERT INTO project_directory VALUES ('project-fixture', '/legacy/project', 'main', NULL, 1700000000000);
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_fixture', 'project-fixture', 'fixture', '/legacy/project', 'Fixture', '1', 1700000000000, 1700000000001);
    INSERT INTO event_sequence VALUES ('ses_fixture', 1, 'owner-fixture');
    INSERT INTO event VALUES ('evt_fixture', 'ses_fixture', 1, 'session.created', '{"info":{"id":"ses_fixture","directory":"/legacy/project"},"text":"/legacy/project is historical text"}');
    INSERT INTO message VALUES ('msg_fixture', 'ses_fixture', 1700000000000, 1700000000001, '{"role":"user","content":"historical text"}');
    INSERT INTO part VALUES ('prt_fixture', 'msg_fixture', 'ses_fixture', 1700000000000, 1700000000001, '{"type":"text","text":"example"}');
    INSERT INTO session_message VALUES ('msg_v2', 'ses_fixture', 'user', 1, 1700000000000, 1700000000001, '{"content":"v2"}');
  `)
  database.close()
  const workspaceRoot = path.join(root, "workspaces")
  const target = path.join(workspaceRoot, "project")
  await fs.mkdir(target, { recursive: true })
  const dataDirectory = path.join(root, "data")
  await fs.mkdir(path.join(dataDirectory, "storage", "session"), { recursive: true })
  await fs.writeFile(
    path.join(dataDirectory, "auth.json"),
    JSON.stringify({ provider: { type: "api", key: "provider-secret" } }),
  )
  await fs.writeFile(path.join(dataDirectory, "mcp-auth.json"), JSON.stringify({ fixture: { token: "mcp-secret" } }))
  await fs.writeFile(
    path.join(dataDirectory, "storage", "session", "fixture.json"),
    JSON.stringify({ persisted: true }),
  )
  const options: SQLiteImport.Options = {
    source,
    workspaceRoot,
    dataDirectory,
    paths: [{ from: "/legacy", to: workspaceRoot }],
    encryption: InstanceStateEncryption.keyFromEnvironment(),
  }
  return {
    source,
    target,
    options,
    mutate: (query: string) => {
      const connection = new Database(source)
      try {
        connection.exec(query)
      } finally {
        connection.close()
      }
    },
  }
}

const importSource = (options: SQLiteImport.Options) => run(Service.use(({ db }) => SQLiteImport.run(db, options)))

test("SQLite dry-run validates every row and leaves source and target unchanged", async () => {
  const input = await fixture()
  const before = await Bun.file(input.source).arrayBuffer()
  const report = await importSource(input.options)
  expect(report.applied).toBe(false)
  expect(report.counts.project).toBe(1)
  expect(report.counts.event).toBe(1)
  expect(report.metadataCount).toBe(3)
  expect(await Bun.file(input.source).arrayBuffer()).toEqual(before)
  const rows = await run(Service.use(({ db }) => db.select().from(ProjectTable)))
  expect(rows).toEqual([])
  expect(await run(Service.use(({ db }) => db.select().from(InstanceStateTable)))).toEqual([])
})

test("SQLite apply preserves records, remaps placement, and encrypts secrets and import journal atomically", async () => {
  const input = await fixture()
  const report = await importSource({ ...input.options, apply: true })
  expect(report.applied).toBe(true)
  const results = await run(
    Service.use(({ db }) =>
      Effect.gen(function* () {
        const accounts = yield* db.select().from(AccountTable)
        const credentials = yield* db.select().from(CredentialTable)
        const sessions = yield* db.select().from(SessionTable)
        const events = yield* db.select().from(EventTable)
        const states = yield* db.select().from(InstanceStateTable)
        const stored = yield* db.execute<{ access_token: string; refresh_token: string }>(
          sql`select access_token, refresh_token from ${AccountTable}`,
        )
        return { accounts, credentials, sessions, events, states, stored }
      }),
    ),
  )
  expect(String(results.accounts[0].id)).toBe("acc_fixture")
  expect(results.accounts[0].time_created).toBe(1700000000000)
  expect(String(results.accounts[0].access_token)).toBe("access-secret")
  expect(String(results.accounts[0].refresh_token)).toBe("refresh-secret")
  expect(results.stored[0].access_token).toStartWith("v1.")
  expect(results.stored[0].refresh_token).not.toContain("refresh-secret")
  expect(results.credentials[0].value as unknown).toEqual({ type: "api", key: "credential-secret" })
  expect(results.credentials[0].active).toBe(true)
  expect(results.sessions[0].directory).toBe(input.target)
  expect(results.events[0].data).toEqual({
    info: { id: "ses_fixture", directory: input.target },
    text: "/legacy/project is historical text",
  })
  const codec = InstanceStateEncryption.codec(input.options.encryption)
  const states = Object.fromEntries(
    results.states.map((state) => [state.namespace, codec.decode(state.namespace, state.key, state.value)]),
  )
  expect(states["provider-auth"]).toEqual({ provider: { type: "api", key: "provider-secret" } })
  expect(states["legacy-storage"]).toEqual({ persisted: true })
  expect(results.states.find((state) => state.namespace === "legacy-storage")?.key).toBe('["session","fixture"]')
  expect((states["sqlite-import"] as { sha256: string }).sha256).toBe(report.sha256)
  await expect(importSource({ ...input.options, apply: true })).rejects.toThrow("not empty")
})

test("SQLite import refuses unsupported columns and incomplete migration journals", async () => {
  const extra = await fixture()
  extra.mutate("ALTER TABLE session ADD COLUMN future_column TEXT")
  await expect(importSource(extra.options)).rejects.toThrow("Unsupported SQLite columns")
  const missing = await fixture()
  missing.mutate("ALTER TABLE session DROP COLUMN metadata")
  await expect(importSource(missing.options)).rejects.toThrow("Unsupported SQLite columns")
  const generated = await fixture()
  generated.mutate("ALTER TABLE session ADD COLUMN generated_column TEXT GENERATED ALWAYS AS (title) VIRTUAL")
  await expect(importSource(generated.options)).rejects.toThrow("Unsupported SQLite columns")
  const incomplete = await fixture()
  incomplete.mutate("DELETE FROM migration WHERE id = (SELECT id FROM migration LIMIT 1)")
  await expect(importSource(incomplete.options)).rejects.toThrow("frozen baseline")
})

test("SQLite import refuses an active target runtime", async () => {
  const input = await fixture()
  const owner = new SQL(process.env.OPENCODE_DATABASE_URL!, { max: 1 })
  try {
    await owner`select pg_advisory_lock(hashtextextended(${`omai:runtime:${schemaName}:${input.options.encryption.instanceID}`}, 0))`
    await expect(importSource(input.options)).rejects.toThrow("Another runtime already owns")
  } finally {
    await owner.close()
  }
})

test("SQLite import detects foreign-key corruption and refuses uncheckpointed sources", async () => {
  const corrupt = await fixture()
  corrupt.mutate("PRAGMA foreign_keys=OFF; UPDATE session SET project_id='missing'")
  await expect(importSource(corrupt.options)).rejects.toThrow("foreign-key integrity")
  const dirty = await fixture()
  await fs.writeFile(dirty.source + "-wal", "uncheckpointed")
  await expect(importSource(dirty.options)).rejects.toThrow("checkpoint SQLite")
})

test("SQLite import rolls back earlier rows when a later source value is invalid", async () => {
  const input = await fixture()
  input.mutate("UPDATE session SET metadata='invalid-json'")
  await expect(importSource({ ...input.options, apply: true })).rejects.toThrow()
  expect(await run(Service.use(({ db }) => db.select().from(AccountTable)))).toEqual([])
  expect(await run(Service.use(({ db }) => db.select().from(ProjectTable)))).toEqual([])
  expect(await run(Service.use(({ db }) => db.select().from(InstanceStateTable)))).toEqual([])
})

test("SQLite import rejects missing copies, unmapped paths, and symlink metadata", async () => {
  const input = await fixture()
  await expect(
    importSource({ ...input.options, paths: [{ from: "/another", to: input.options.workspaceRoot }] }),
  ).rejects.toThrow("no explicit migration mapping")
  await fs.rm(input.target, { recursive: true })
  await expect(importSource(input.options)).rejects.toThrow()
  await fs.mkdir(input.target)
  await fs.rename(
    path.join(input.options.dataDirectory!, "storage"),
    path.join(input.options.dataDirectory!, "elsewhere"),
  )
  await fs.symlink("elsewhere", path.join(input.options.dataDirectory!, "storage"))
  await expect(importSource(input.options)).rejects.toThrow("symlink directories")
})

test("path mappings use longest explicit prefix and cannot match sibling prefixes", () => {
  const mappings = [
    { from: "/old", to: "/new" },
    { from: "/old/project", to: "/specific" },
  ]
  expect(SQLiteImport.mapPath("/old/project/src", mappings)).toBe("/specific/src")
  expect(SQLiteImport.mapPath("C:\\old\\project", [{ from: "C:/old", to: "/new" }])).toBe("/new/project")
  expect(SQLiteImport.mapPath("/child", [{ from: "/", to: "/new" }])).toBe("/new/child")
  expect(() => SQLiteImport.mapPath("/older/project", mappings)).toThrow("no explicit migration mapping")
  expect(() => SQLiteImport.mapPath("/old/../escape", mappings)).toThrow("no explicit migration mapping")
})

test("SQLite checkpoints keep their identity and content while remapping validated worktree placement", async () => {
  const input = await fixture()
  const targetDataRoot = path.join(path.dirname(input.source), "target-data")
  const repository = path.join(
    targetDataRoot,
    "snapshot",
    "project-fixture",
    createHash("sha1").update(input.target).digest("hex"),
  )
  await fs.mkdir(repository, { recursive: true })
  const initialized = Bun.spawnSync(["git", "init", "--bare", repository])
  expect(initialized.exitCode).toBe(0)
  const tree = Bun.spawnSync(["git", `--git-dir=${repository}`, "hash-object", "-w", "-t", "tree", "--stdin"], {
    stdin: new Uint8Array(),
  })
  expect(tree.exitCode).toBe(0)
  const snapshotHash = tree.stdout.toString().trim()
  const value = {
    id: "chk_fixture",
    projectID: "project-fixture",
    worktree: "/legacy/project",
    snapshotHash,
    sessionID: "ses_fixture",
    messageID: "msg_fixture",
    files: ["historical/path.ts"],
    additions: 1,
    deletions: 0,
    database: [],
    memory: [],
    time: { created: 1700000000000 },
    title: "Keep checkpoint contents",
  }
  const filename = path.join(input.options.dataDirectory!, "storage", "checkpoint", value.projectID, `${value.id}.json`)
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const original = JSON.stringify(value)
  await fs.writeFile(filename, original)
  await expect(importSource(input.options)).rejects.toThrow("explicit target data root")
  const options = { ...input.options, targetDataRoot }
  await importSource({ ...options, apply: true })
  const rows = await run(Service.use(({ db }) => db.select().from(InstanceStateTable)))
  const key = JSON.stringify(["checkpoint", value.projectID, value.id])
  const row = rows.find((item) => item.namespace === "legacy-storage" && item.key === key)
  expect(row).toBeDefined()
  const codec = InstanceStateEncryption.codec(options.encryption)
  expect(codec.decode(row!.namespace, row!.key, row!.value)).toEqual({ ...value, worktree: input.target })
  expect(await fs.readFile(filename, "utf8")).toBe(original)
})

test("SQLite checkpoint metadata refuses a missing destination snapshot before importing database rows", async () => {
  const input = await fixture()
  const targetDataRoot = path.join(path.dirname(input.source), "target-data")
  await fs.mkdir(targetDataRoot)
  const filename = path.join(
    input.options.dataDirectory!,
    "storage",
    "checkpoint",
    "project-fixture",
    "chk_fixture.json",
  )
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(
    filename,
    JSON.stringify({
      id: "chk_fixture",
      projectID: "project-fixture",
      worktree: "/legacy/project",
      snapshotHash: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      database: [],
    }),
  )
  await expect(importSource({ ...input.options, targetDataRoot, apply: true })).rejects.toThrow()
  expect(await run(Service.use(({ db }) => db.select().from(ProjectTable)))).toEqual([])
  expect(await run(Service.use(({ db }) => db.select().from(InstanceStateTable)))).toEqual([])
})
