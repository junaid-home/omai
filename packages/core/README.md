# @opencode-ai/core

Core services use PostgreSQL through Effect and Drizzle. Central instances keep application state in
PostgreSQL and workspaces, Git objects, snapshots, and configuration on a dedicated filesystem volume.
SQLite is supported as an import source; it is not a runtime fallback.

## Configuration

Set configuration before importing application modules. Schema and storage settings are bound at module
initialization. For a central instance, configure:

| Variable | Value |
| --- | --- |
| `OPENCODE_DATABASE_URL` | PostgreSQL connection URL for a restricted runtime role. |
| `OPENCODE_DATABASE_SCHEMA` | Dedicated lowercase schema name; not `public` or a PostgreSQL system schema. |
| `OPENCODE_INSTANCE_ID` | Stable instance identifier, retained with its database and encryption key. |
| `OPENCODE_DATA_KEY` | Random 32-byte key encoded as canonical base64. |
| `OPENCODE_STORAGE_MODE` | `central`. |
| `OPENCODE_STORAGE_ROOT` | Absolute, canonical path to an existing writable Linux mount point. |
| `OPENCODE_STORAGE_ID` | Stable volume identifier matching the provisioned storage marker. |
| `OPENCODE_AUTH_MODE` | `central`. Central storage rejects local authentication. |
| `OPENCODE_PUBLIC_URL` | Application HTTPS origin, without a path, query, or fragment. |
| `OPENCODE_PREVIEW_URL` | Preview HTTPS origin with a different hostname. |
| `OPENCODE_JWT_SECRET` | Independent random signing secret containing at least 32 bytes. |
| `OPENCODE_REGISTRATION_SECRET` | Optional invitation secret, at least 32 characters. `OPENCODE_SIGNUP_TOKEN` is a supported legacy alias. |

Registration is closed when neither invitation secret is configured.

The database URL, migrator URL, data key, JWT secret, and registration secret each support a `_FILE`
variant containing the value as UTF-8 text. Configure either the value or its file, never both. Keep
secret files private and outside workspaces. This is not a general `_FILE` convention for other settings.

`OPENCODE_DATABASE_POOL_SIZE` optionally sets 2–100 connections. `OPENCODE_PREVIEW_PORT` defaults to
4097 and must differ from the application listener. Route the two public hostnames to their respective
listeners, preserving the public `Host`. Use HTTPS hostnames under the same registrable domain so
preview cookies work inside the application iframe. The preview listener must never expose the API.

Authenticated requests use a bearer token or the `omai_session` cookie. Cookie-authenticated mutations
and WebSocket upgrades require an `Origin` matching `OPENCODE_PUBLIC_URL`; an explicit conflicting
origin is also rejected when those requests use bearer tokens. Invitation links use `/signup-secret-route#invite=TOKEN`.
Treat that token as a secret and share it only with intended users.

## Storage and migrations

Prepare the mounted volume and database before starting the application. Use a separate migration role
that can create and own the instance schema. The runtime role must not own the schema or tables, have
DDL privileges, or inherit administrative roles. Set `OPENCODE_DATABASE_MIGRATOR_URL` (or its `_FILE`
variant) and `OPENCODE_DATABASE_RUNTIME_ROLE` for the migration command to grant runtime permissions.
The database and both login roles must already exist.

With the instance and all workspace processes stopped, run from this package:

```sh
bun run script/storage-init.ts
flock --nonblock --no-fork "$OPENCODE_STORAGE_ROOT/.runtime.lock" bun run migration:apply
```

Storage initialization verifies the mount, records its identity, and creates the managed directories;
it does not mount or format a disk. Run it as the unprivileged account that will own the runtime files.
Central mode does not permit `OPENCODE_CONFIG` or `OPENCODE_CONFIG_DIR` path overrides.

Startup verifies migration checksums, instance identity, and runtime role permissions. It does not
apply migrations automatically. Append migrations instead of modifying SQL already applied to a database.

## Runtime ownership and recovery

Only one complete runtime may actively use an instance database and volume. The server holds a
PostgreSQL advisory lock and terminates on ownership loss, but does not acquire the filesystem lock.
The launcher must hold an exclusive `flock` on `$OPENCODE_STORAGE_ROOT/.runtime.lock` for the entire
runtime lifetime. Use that same lock for migrations, imports, backups, and restores. Preserve the lock
file's inode and ensure the runtime account can open it.

The supervisor must stop the entire process tree, including PTYs, shells, and background processes,
before maintenance or starting a replacement. A released database lock alone does not prove those
processes have stopped. Shared-volume failover requires infrastructure to revoke the previous writer;
mount validation and advisory locks are not distributed process fencing.

This is a shared instance for a trusted team. Workspaces and provider credentials are shared; user
authentication and personal state do not provide tenant isolation from code executed by other users.
Workspace commands execute with the runtime account's privileges.

Back up and restore PostgreSQL, the complete volume, configuration, and secret keys as one matched set
while all writers are stopped and the volume lock is held. Preserve instance and storage identities.
Keep prior keys with prior backups. PostgreSQL transactions cannot atomically include filesystem
changes; an interrupted checkpoint rollback or restore requires reconciliation before restarting.

## Imports and key rotation

The existing offline tools describe their inputs and validation through `--help`:

```sh
bun run script/import-sqlite.ts --help
bun run script/import-snapshots.ts --help
bun run script/import-checkpoints.ts --help
bun run script/rotate-data-key.ts --help
```

Imports require both instances stopped and the external volume lock held. Copy workspaces and import
Git snapshots and checkpoint artifacts before importing SQLite metadata into a migrated, empty target.
All four commands validate by default and require `--apply` to write. Key rotation acquires its own
volume and PostgreSQL locks: do not wrap it in another lock on the same file. After successful rotation,
update the configured data key before restarting; the tool does not modify secret files.

## Development

Use the repository's pinned Bun version and install dependencies from the repository root. Run tests
from package directories as an unprivileged OS user, in a clean environment without instance secrets.
Set `OMAI_TEST_DATABASE_URL` to an administrative connection for a disposable PostgreSQL test database.
The fixtures create isolated schemas, restricted runtime roles, and temporary databases; the test
administrator therefore needs permission to create and remove those resources. Never use a production
database or credentials.

```sh
cd packages/core
bun run typecheck
bun run migration:check
bun run test
```

Related package commands are `bun run test:httpapi` in `packages/opencode`, and `bun run test:central`
and `bun run test:preview` in `packages/app`. Browser tests require Playwright Chromium. Package test
fixtures and scripts remain the source of truth for their individual prerequisites.
