import { describe, expect, test } from "bun:test"
import { dispatch } from "../../src/publish/dispatcher"

function makeEnv(hostnames: Record<string, string> = {}, fail?: Record<string, Error>) {
  const calls: string[] = []
  return {
    calls,
    env: {
      DISPATCHER: {
        get(name: string) {
          calls.push(name)
          return {
            fetch: async () => {
              if (fail?.[name]) throw fail[name]
              return new Response(`app:${name}`)
            },
          }
        },
      },
      HOSTNAMES: { get: async (key: string) => hostnames[key] ?? null },
    },
  }
}

describe("dispatch", () => {
  test("zone subdomain dispatches to the app script", async () => {
    const { env, calls } = makeEnv()
    const res = await dispatch(new Request("https://my-shop.omai.ch/x"), env, "omai.ch")
    expect(calls).toEqual(["my-shop"])
    expect(await res.text()).toBe("app:my-shop")
  })

  test("custom hostname resolves through KV", async () => {
    const { env, calls } = makeEnv({ "shop.example.com": "my-shop" })
    const res = await dispatch(new Request("https://shop.example.com/"), env, "omai.ch")
    expect(calls).toEqual(["my-shop"])
    expect(res.status).toBe(200)
  })

  test("unknown hostname returns 404", async () => {
    const { env, calls } = makeEnv()
    const res = await dispatch(new Request("https://unknown.example.com/"), env, "omai.ch")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Not found")
    expect(calls).toEqual([])
  })

  test("reserved names are never dispatched", async () => {
    const { env, calls } = makeEnv()
    const res = await dispatch(new Request("https://www.omai.ch/"), env, "omai.ch")
    expect(res.status).toBe(404)
    expect(calls).toEqual([])
  })

  test("missing worker returns 404", async () => {
    const { env } = makeEnv({}, { gone: new Error("Worker not found") })
    const res = await dispatch(new Request("https://gone.omai.ch/"), env, "omai.ch")
    expect(res.status).toBe(404)
  })

  test("deleted worker returns 404", async () => {
    const { env } = makeEnv({}, { gone: new Error("this worker has been deleted") })
    const res = await dispatch(new Request("https://gone.omai.ch/"), env, "omai.ch")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Not found")
  })

  test("missing worker thrown synchronously by get returns 404", async () => {
    const env = {
      DISPATCHER: {
        get(): { fetch(r: Request): Promise<Response> } {
          throw new Error("Worker not found")
        },
      },
      HOSTNAMES: { get: async () => null },
    }
    const res = await dispatch(new Request("https://gone.omai.ch/"), env, "omai.ch")
    expect(res.status).toBe(404)
  })

  test("other dispatch errors propagate", async () => {
    const { env } = makeEnv({}, { boom: new Error("kaput") })
    await expect(dispatch(new Request("https://boom.omai.ch/"), env, "omai.ch")).rejects.toThrow("kaput")
  })
})
