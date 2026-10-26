# @opencode-ai/northflank

Runs each OpenCode workspace as an isolated Northflank MicroVM: one service +
one volume per project directory, with automatic suspend after 60s of genuine
inactivity and automatic resume when the project is opened again.

Registration is a single BUILTIN line in `packages/opencode/src/control-plane/adapters.ts`;
nothing else in `opencode` imports this package, and the frontend stays untouched —
routing to remote workspaces is resolved server-side through the adapter's `target()`.

## How it works

- **Create** — `createService` with a deterministic name (`vm-<slug(workspaceID)>`)
  as the idempotency key, a `createVolume` (`vol-<slug(workspaceID)>`) mounted at the
  workspace's directory path inside the container, and `attachVolume`. The service
  runs `Dockerfile.opencode`'s `opencode serve` on port 4096 behind Northflank's
  public HTTPS endpoint.
- **Identity** — the control plane injects the runtime environment as *flat scalar*
  variables (the real API rejects a nested `variables` object): auth bundle,
  workspace ID, OTel settings, and the VM's database identity
  (`OPENCODE_DATABASE_URL` / `OPENCODE_DATABASE_SCHEMA` / `OPENCODE_INSTANCE_ID` /
  `OPENCODE_DATA_KEY`), which a pre-provisioning step sets on the control plane
  before `Workspace.create`. Migrator credentials never leave the control plane,
  and the public image never carries credentials.
- **Suspend/resume** — idle sweeps call `pauseService`; opening the project calls
  `resumeService` and the request blocks until the VM answers health and the sync
  stream reconnects. Stop is never delete; `remove` deletes service + volume.
- **Busy gating** — `busy()` asks the VM's `/busy` endpoint, so builds, tests, git,
  and shells running *inside* the VM keep it awake; sync-loop traffic alone does
  not count as activity.

## Configuration

All optional except the token:

| Env | Default |
|---|---|
| `NORTHFLANK_API_TOKEN` | *(required, secret)* |
| `NORTHFLANK_PROJECT_ID` / `NORTHFLANK_PROJECT` | `omai` |
| `NORTHFLANK_IMAGE` | `jj123dev/omaiflank` |
| `NORTHFLANK_DEPLOYMENT_PLAN` | `nf-compute-100-4` |
| `NORTHFLANK_VOLUME_SIZE_GB` | `10` |
| `NORTHFLANK_SERVICE_PORT` | `4096` |
| `NORTHFLANK_SERVICE_SCHEME` | `https` (`http` for local stubs) |
| `NORTHFLANK_VM_USERNAME` / `NORTHFLANK_VM_PASSWORD` | `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` |
| `NORTHFLANK_API_BASE` | `https://api.northflank.com/v1` |

Untagged image references default to `:latest` — the API's `imagePath` pattern
requires an explicit tag or digest.

## Image

Northflank MicroVMs run `architecture: "x86"`, so the image must be amd64. An
arm64 image deploys but crash-loops at the entrypoint with
`Exec format error (os error 8)` (`ENOEXEC` — the kernel refusing to exec a
binary for the wrong ISA).

```sh
docker buildx build --platform linux/amd64 \
  -f Dockerfile.opencode -t jj123dev/omaiflank:latest --push .
```

Passing `--platform` is required when building on an Apple Silicon Mac: without
it the build emits a single-arch arm64 manifest under `:latest`, which is
exactly the failure above. To cover both, push a manifest list rather than
omitting the flag:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f Dockerfile.opencode -t jj123dev/omaiflank:latest --push .
```

CI builds this in `.github/workflows/deploy-k8s.yml` (`vm` job), which targets
`linux/amd64` on the `feature/microvm` branch.

The build whitelist in `Dockerfile.opencode` must include `packages/northflank`.

## Tests

- `bun test` in this package — unit tests against a local HTTP stub.
- `packages/opencode/test/e2e/northflank-suspend-resume.test.ts` — stub E2E: a
  local fake Northflank API that really spawns/kills a second `opencode serve`;
  boot, suspend, resume with file/git/session persistence, and 10 concurrent
  wakes collapsing to exactly one resume.
- `packages/opencode/test/e2e/northflank-live.test.ts` — gated live suite against
  the real API: create → boot → suspend → resume → persistence → delete. Runs only
  when `NORTHFLANK_API_TOKEN` is set (manual/nightly, never CI) and needs
  `OMAI_TEST_DATABASE_URL` (control plane) plus `NORTHFLANK_LIVE_DATABASE_URL` (a
  Postgres admin URL reachable from *both* this machine and Northflank; each run
  provisions and drops its own schema there).

## Known gaps (Phase F)

- Per-VM database provisioning is not yet wired into `Workspace.create` — the
  control plane forwards whatever DB identity it was started with; the live suite
  pre-provisions per run, production needs the provision-at-create step.
- The `setRuntimeEnvironment` refresh path (existing-service branch) has not been
  exercised against the real API.
