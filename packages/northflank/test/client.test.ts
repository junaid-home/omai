import { afterEach, describe, expect, test } from "bun:test"
import { createClient, NorthflankApiError } from "../src/client.js"
import { configFromEnv } from "../src/config.js"
import { northflankStub } from "./stub.js"

let active: Array<() => void> = []

afterEach(() => {
  while (active.length) active.pop()?.()
})

function setup() {
  const stub = northflankStub()
  active.push(stub.stop)
  const client = createClient(
    configFromEnv({
      NORTHFLANK_API_TOKEN: stub.token,
      NORTHFLANK_API_BASE: stub.apiBase,
      NORTHFLANK_PROJECT_ID: "omai",
    }),
  )
  return { stub, client }
}

describe("northflank.client", () => {
  test("lists services with bearer auth", async () => {
    const { stub, client } = setup()
    stub.services.set("svc-a", { id: "svc-a", name: "vm-alpha", payload: {}, paused: false })

    const services = await client.listServices()

    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({ id: "svc-a", name: "vm-alpha" })
    expect(stub.requests[0]).toMatchObject({ method: "GET", path: "/v1/projects/omai/services" })
    expect(stub.requests[0].authorization).toBe(`Bearer ${stub.token}`)
  })

  test("creates a service and returns its id", async () => {
    const { stub, client } = setup()

    const created = await client.createService<{ data: { id: string } }>({
      name: "vm-demo",
      billing: { deploymentPlan: "nf-compute-100-4" },
    })

    expect(created.data.id).toBe("vm-demo")
    expect(stub.services.has("vm-demo")).toBe(true)
  })

  test("maps API failures to NorthflankApiError", async () => {
    const { client } = setup()

    const error = await client.getService("missing").catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(NorthflankApiError)
    expect((error as NorthflankApiError).status).toBe(404)
    expect((error as Error).message).toContain("Could not find service")
  })

  test("tolerates deleting a service that does not exist", async () => {
    const { client } = setup()
    await expect(client.deleteService("missing")).resolves.toBeUndefined()
  })

  test("retries a request rejected by the team rate limit", async () => {
    const { stub, client } = setup()
    stub.services.set("svc-a", { id: "svc-a", name: "vm-alpha", payload: {}, paused: false })
    stub.throttle(2)

    const services = await client.listServices()

    expect(services).toHaveLength(1)
    expect(stub.requests).toHaveLength(3)
  })

  test("gives up after repeated rate limiting", async () => {
    const { stub, client } = setup()
    stub.throttle(10)

    await expect(client.listServices()).rejects.toMatchObject({ status: 429, name: "NorthflankApiError" })
    expect(stub.requests).toHaveLength(4)
  })

  test("fails fast without a token", async () => {
    const client = createClient(configFromEnv({ NORTHFLANK_API_BASE: "http://127.0.0.1:1/v1" }))
    await expect(client.listServices()).rejects.toMatchObject({ status: 401, name: "NorthflankApiError" })
  })
})
