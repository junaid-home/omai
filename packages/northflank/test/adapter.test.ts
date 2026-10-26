import { afterEach, describe, expect, test } from "bun:test"
import { northflankAdapter } from "../src/adapter.js"
import { configFromEnv } from "../src/config.js"
import type { WorkspaceInfo } from "../src/types.js"
import { northflankStub, vmStub } from "./stub.js"

const active: Array<() => void> = []

afterEach(() => {
  while (active.length) active.pop()?.()
})

function setup() {
  const vm = vmStub()
  const stub = northflankStub({ dns: vm.host })
  active.push(vm.stop, stub.stop)
  const config = configFromEnv({
    NORTHFLANK_API_TOKEN: stub.token,
    NORTHFLANK_API_BASE: stub.apiBase,
    NORTHFLANK_PROJECT_ID: "omai",
    NORTHFLANK_SERVICE_SCHEME: "http",
    NORTHFLANK_VM_PASSWORD: "vm-secret",
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
      deployment: { instances: 1, external: { imagePath: "jj123dev/omaiflank:latest" } },
      ports: [{ name: "p01", internalPort: 4096, public: true }],
    })
    // runtimeEnvironment is a flat scalar map (the real API rejects nested values).
    const variables = service.payload.runtimeEnvironment as Record<string, string>
    expect(variables).toMatchObject({ MY_VAR: "hello", OPENCODE_AUTH_CONTENT: "{}", OPENCODE_SERVER_USERNAME: "omai" })

    expect(stub.volumes.size).toBe(1)
    const volume = [...stub.volumes.values()][0]!
    expect(volume.payload).toMatchObject({
      mounts: [{ containerMountPath: directory }],
      spec: { accessMode: "ReadWriteOnce", storageSize: 10 * 1024 },
    })
    expect(stub.requests.some((request) => request.path.endsWith("/attach"))).toBe(true)
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
    const variables = (refresh?.body as { variables: Record<string, string> }).variables
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

  test("start and stop map to resume and pause", async () => {
    const { stub, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    await adapter.stop?.(configured)
    expect([...stub.services.values()][0]!.paused).toBe(true)
    await adapter.start?.(configured)
    expect([...stub.services.values()][0]!.paused).toBe(false)

    const actions = stub.requests.map((request) => request.path).filter((path) => /pause|resume/.test(path))
    expect(actions).toEqual(["/v1/projects/omai/services/vm-w-01jxample0000000000000000ab/pause", "/v1/projects/omai/services/vm-w-01jxample0000000000000000ab/resume"])
  })

  test("start treats resuming an already-running service as success", async () => {
    const { adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    // A wake can race the service state; "not paused" means the VM is up,
    // which is exactly what the caller asked for.
    await expect(adapter.start?.(configured)).resolves.toBeUndefined()
  })

  test("busy reports VM job state and treats unreachable VMs as idle", async () => {
    const { vm, adapter, info, directory } = setup()
    const configured = await adapter.configure(info, { instance: { directory } })
    await adapter.create(configured, {})

    expect(await adapter.busy?.(configured)).toEqual({ busy: false, reasons: [] })

    vm.setBusy(true, ["build"])
    expect(await adapter.busy?.(configured)).toEqual({ busy: true, reasons: ["build"] })

    vm.crash()
    expect(await adapter.busy?.(configured)).toEqual({ busy: false, reasons: ["unreachable"] })
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
