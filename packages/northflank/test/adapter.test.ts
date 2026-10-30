import { afterEach, describe, expect, test } from "bun:test"
import { northflankAdapter } from "../src/adapter.js"
import { configFromEnv } from "../src/config.js"
import type { WorkspaceInfo } from "../src/types.js"
import { northflankStub, vmStub } from "./stub.js"

const active: Array<() => void> = []

afterEach(() => {
  while (active.length) active.pop()?.()
})

function setup(env: Record<string, string> = {}) {
  const vm = vmStub()
  const stub = northflankStub({ dns: vm.host })
  active.push(vm.stop, stub.stop)
  const config = configFromEnv({
    NORTHFLANK_API_TOKEN: stub.token,
    NORTHFLANK_API_BASE: stub.apiBase,
    NORTHFLANK_PROJECT_ID: "omai",
    NORTHFLANK_SERVICE_SCHEME: "http",
    NORTHFLANK_VM_PASSWORD: "vm-secret",
    ...env,
  })
  const adapter = northflankAdapter(config)
  const info: WorkspaceInfo = {
    id: "w_01JXAMPLE0000000000000000AB",
    type: "northflank",
    name: "spring-otter",
    branch: null,
    directory: null,
    extra: null,
    projectID: "proj_1",
  }
  const directory = "/workspace/projects/demo"
  return { vm, stub, adapter, info, directory, config }
}

describe("northflank.adapter", () => {
  test("configure pins the directory for path parity and requires an instance", async () => {
    const { adapter, info, directory } = setup()

    expect(() => adapter.configure(info)).toThrow("instance context")
    const configured = await adapter.configure(info, { instance: { directory } })
    expect(configured.directory).toBe(directory)
  })

  test("create provisions service, volume and attachment with the handed-over env", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })

    await adapter.create(configured, { OPENCODE_AUTH_CONTENT: "{}", MY_VAR: "hello" })

    expect(stub.services.size).toBe(1)
    const service = [...stub.services.values()][0]!
    expect(service.payload).toMatchObject({
      billing: { deploymentPlan: "nf-compute-100-4" },
      // Untagged images normalize to :latest — the API requires an explicit tag.
      // Created idle and scaled after the volume attach, so the VM boots once.
      deployment: { instances: 0, external: { imagePath: "jj123dev/microvm:latest" } },
      ports: [{ name: "p01", internalPort: 4096, public: true }],
    })
    // runtimeEnvironment is a flat scalar map (the real API rejects nested values).
    const variables = service.payload.runtimeEnvironment as Record<string, string>
    expect(variables).toMatchObject({ MY_VAR: "hello", OPENCODE_AUTH_CONTENT: "{}", OPENCODE_SERVER_USERNAME: "omai" })

    expect(stub.volumes.size).toBe(1)
    const volume = [...stub.volumes.values()][0]!
    expect(volume.payload).toMatchObject({
      // Mounted at the shared workspace folder so a reserve VM fits any project.
      mounts: [{ containerMountPath: "/workspace" }],
      spec: { accessMode: "ReadWriteOnce", storageSize: 10 * 1024 },
    })
    const paths = stub.requests.map((request) => request.path)
    const attach = paths.findIndex((path) => path.endsWith("/attach"))
    const scale = stub.requests.findIndex((request) => request.method === "PATCH")
    expect(attach).toBeGreaterThan(-1)
    expect(scale).toBeGreaterThan(attach)
    expect(service.instances).toBe(1)
  })

  test("create hands the global config to the VM only when configured", async () => {
    const plain = setup()
    await plain.adapter.create(
      await plain.adapter.configure(plain.info, { instance: { directory: plain.directory } }),
      {},
    )
    const bare = [...plain.stub.services.values()][0]!.payload.runtimeEnvironment as Record<string, string>
    expect(bare).not.toHaveProperty("OPENCODE_GLOBAL_CONFIG")

    const global = JSON.stringify({ permission: "allow", share: { mode: "manual" } })
    const configured = setup({ NORTHFLANK_VM_GLOBAL_CONFIG: global })
    await configured.adapter.create(
      await configured.adapter.configure(configured.info, { instance: { directory: configured.directory } }),
      {},
    )
    const variables = [...configured.stub.services.values()][0]!.payload.runtimeEnvironment as Record<string, string>
    expect(variables.OPENCODE_GLOBAL_CONFIG).toBe(global)
  })

  test("two control planes creating the same VM at once both succeed on one service", async () => {
    const { stub, adapter, info, directory, config } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })

    await Promise.all([adapter.create(configured, {}), northflankAdapter(config).create(configured, {})])

    expect(stub.services.size).toBe(1)
    expect(stub.volumes.size).toBe(1)
    expect([...stub.services.values()][0]!.instances).toBe(1)
  })

  test("create finds an existing service beyond the first page", async () => {
    const { stub, adapter, info, directory, config } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})
    // Push ours behind three others, off the first page.
    const ours = [...stub.services.values()][0]!
    stub.services.delete(ours.id)
    for (const name of ["vm-other-a", "vm-other-b", "vm-other-c"])
      stub.services.set(name, { id: name, name, payload: {}, paused: false })
    stub.services.set(ours.id, ours)

    // A fresh adapter has no cached IDs, as after a control-plane restart.
    await northflankAdapter(config).create(configured, {})

    expect(stub.services.size).toBe(4)
    expect(
      stub.requests.filter((request) => request.method === "POST" && request.path.endsWith("/services/deployment")),
    ).toHaveLength(1)
  })

  test("create describes the service with its project, owner and workspace", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(
      { ...info, extra: { owner: { username: "alice", email: "alice@example.test" } } },
      { instance: { directory } },
    )

    await adapter.create(configured, {})

    const description = [...stub.services.values()][0]!.payload.description as string
    expect(description).toContain(`project: ${directory}`)
    expect(description).toContain("user: alice (alice at example.test)")
    expect(description).toContain(`workspace: ${info.id}`)
    expect(description.length).toBeLessThanOrEqual(200)
    // Northflank's documented description pattern; anything else is a 400.
    expect(description).toMatch(/^[a-zA-Z0-9.,?\s\\/'"()[\];`%^&*\-_:!]+$/)
  })

  test("create keeps a long description within Northflank's rules", async () => {
    const { stub, adapter, info } = setup()
    const directory = `/home/runner/workspace/${"très-long-name+".repeat(20)}`
    const configured = await adapter.configure(
      { ...info, extra: { owner: { username: "bob", email: "b+o@x.test" } } },
      { instance: { directory } },
    )

    await adapter.create(configured, {})

    const description = [...stub.services.values()][0]!.payload.description as string
    expect(description.length).toBeLessThanOrEqual(200)
    expect(description).toMatch(/^[a-zA-Z0-9.,?\s\\/'"()[\];`%^&*\-_:!]+$/)
  })

  test("create describes a service with no known owner without failing", async () => {
    const { stub, adapter, info, directory } = setup()
    await adapter.create(await adapter.configure(info, { instance: { directory } }), {})

    const description = [...stub.services.values()][0]!.payload.description as string
    expect(description).toContain(`project: ${directory}`)
    expect(description).not.toContain("user:")
  })

  test("create moves an existing service onto the configured image", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})
    const service = [...stub.services.values()][0]!
    service.payload["deployment"] = { instances: 1, external: { imagePath: "jj123dev/old-image:latest" } }

    await adapter.create(configured, {})

    expect(service.payload["deployment"]).toMatchObject({ external: { imagePath: "jj123dev/microvm:latest" } })
  })

  test("start scales a service left at zero instances", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})
    const service = [...stub.services.values()][0]!
    service.instances = 0

    await adapter.start!(configured)

    expect(service.instances).toBe(1)
  })

  test("remove with keepVolume deletes only the service", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    await adapter.remove(configured, { keepVolume: true })
    expect(stub.services.size).toBe(0)
    expect(stub.volumes.size).toBe(1)

    await adapter.create(configured, {})
    await adapter.remove(configured)
    expect(stub.services.size).toBe(0)
    expect(stub.volumes.size).toBe(0)
  })

  test("health reports a crashed deployment and a running one", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})
    const service = [...stub.services.values()][0]!

    service.deployment = { status: "FAILED", reason: "DEPLOYING" }
    expect(await adapter.health!(configured)).toEqual({ state: "failed", reason: "Deployment failed" })

    service.deployment = { status: "COMPLETED", reason: "DEPLOYING" }
    service.containers = ["TASK_FAILED"]
    expect(await adapter.health!(configured)).toEqual({ state: "failed", reason: "Container exited (TASK_FAILED)" })

    service.containers = ["TASK_RUNNING"]
    expect(await adapter.health!(configured)).toEqual({ state: "running" })

    service.deployment = { status: "IN_PROGRESS", reason: "DEPLOYING" }
    service.containers = ["TASK_STARTING"]
    expect(await adapter.health!(configured)).toEqual({ state: "pending" })
  })

  test("create is idempotent across restarts and refreshes runtime env", async () => {
    const { stub, info, directory, config } = setup()
    const configured = await northflankAdapter(config).configure(info, { instance: { directory } })
    await northflankAdapter(config).create(configured, { MY_VAR: "first" })

    // Fresh adapter (cold cache, as after a control-plane restart).
    await northflankAdapter(config).create(configured, { MY_VAR: "second" })

    expect(stub.services.size).toBe(1)
    expect(stub.volumes.size).toBe(1)
    const refresh = stub.requests.findLast((request) => request.path.endsWith("/runtime-environment"))
    expect(refresh).toBeDefined()
    const variables = (refresh?.body as { runtimeEnvironment: Record<string, string> }).runtimeEnvironment
    expect(variables.MY_VAR).toBe("second")
  })

  test("target resolves the public address and basic-auth headers", async () => {
    const { vm, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    const target = await adapter.target(configured)

    expect(target.type).toBe("remote")
    expect(String(target.type === "remote" ? target.url : "")).toBe(`http://${vm.host}`)
    const headers = target.type === "remote" ? target.headers : undefined
    expect(headers).toMatchObject({ Authorization: `Basic ${btoa("omai:vm-secret")}` })
  })

  test("target resolves the address from the API once per workspace", async () => {
    const { stub, info, directory, config } = setup()
    const adapter = northflankAdapter(config)
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})
    const before = stub.requests.length

    await adapter.target(configured)
    await adapter.target(configured)
    await adapter.busy?.(configured)

    // The team-wide API rate limit cannot absorb a lookup per proxied request.
    expect(stub.requests.slice(before).map((request) => request.path)).toEqual([
      "/v1/projects/omai/services/vm-w-01jxample0000000000000000ab/ports",
    ])
  })

  test("start reports a service deleted out-of-band as gone", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})
    await adapter.target(configured)

    stub.services.clear()

    await expect(adapter.start?.(configured)).rejects.toMatchObject({ name: "WorkspaceGoneError" })
    // The cached address is dropped with it, so the next lookup sees the loss.
    await expect(adapter.target(configured)).rejects.toMatchObject({ name: "WorkspaceGoneError" })
  })

  test("start and stop map to resume and pause", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    await adapter.stop?.(configured)
    expect([...stub.services.values()][0]!.paused).toBe(true)
    await adapter.start?.(configured)
    expect([...stub.services.values()][0]!.paused).toBe(false)

    const actions = stub.requests.map((request) => request.path).filter((path) => /pause|resume/.test(path))
    expect(actions).toEqual([
      "/v1/projects/omai/services/vm-w-01jxample0000000000000000ab/pause",
      "/v1/projects/omai/services/vm-w-01jxample0000000000000000ab/resume",
    ])
  })

  test("start treats resuming an already-running service as success", async () => {
    const { adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    // A wake can race the service state; "not paused" means the VM is up,
    // which is exactly what the caller asked for.
    await expect(adapter.start?.(configured)).resolves.toBeUndefined()
  })

  test("busy reports VM job state and fails for an unreachable VM instead of calling it idle", async () => {
    const { vm, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    expect(await adapter.busy?.(configured)).toEqual({ busy: false, reasons: [] })

    vm.setBusy(true, ["build"])
    expect(await adapter.busy?.(configured)).toEqual({ busy: true, reasons: ["build"] })

    vm.crash()
    await expect(adapter.busy?.(configured)).rejects.toThrow()
  })

  test("remove deletes the service and volume, and tolerates repeats", async () => {
    const { stub, adapter, info, directory, config } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    await adapter.remove(configured)
    expect(stub.services.size).toBe(0)
    expect(stub.volumes.size).toBe(0)

    await northflankAdapter(config).remove(configured)
  })
})
