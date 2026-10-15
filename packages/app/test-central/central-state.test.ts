import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { persistedCentral } from "../src/utils/central-persist"
import { importBrowserState } from "../src/utils/central-import"
import { previewUrl } from "../src/utils/preview-url"
import {
  bootstrapCentralState,
  centralRuntime,
  createCentralState,
  stateAddress,
  StateConflictError,
  type CentralState,
  type StateRevision,
} from "../src/utils/central-state"

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
  centralRuntime.configure({ mode: "local" })
})

function fixture() {
  const rows = new Map<string, StateRevision>()
  const controls = {
    offline: false,
    lostAck: false,
    writes: 0,
    requests: 0,
    delayRead: undefined as Promise<void> | undefined,
    userID: "alice",
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/auth/config") return Response.json({ mode: "central" })
      if (url.pathname === "/auth/me")
        return Response.json({ id: "alice", username: "Alice", email: "alice@example.test" })
      if (url.pathname === "/user-state") controls.requests++
      if (controls.offline) return new Response("Unavailable", { status: 503 })
      if (url.pathname !== "/user-state") return new Response(null, { status: 404 })
      if (request.headers.get("X-Opencode-User-ID") !== controls.userID) return new Response(null, { status: 401 })
      if (request.method === "GET") {
        const row = rows.get(JSON.stringify([url.searchParams.get("namespace"), url.searchParams.get("key")])) ?? {
          revision: 0,
          value: null,
        }
        if (controls.delayRead) await controls.delayRead
        return Response.json(row)
      }
      const body = (await request.json()) as {
        namespace: string
        key: string
        expectedRevision: number
        value: string | null
      }
      const key = JSON.stringify([body.namespace, body.key])
      const current = rows.get(key) ?? { revision: 0, value: null }
      if (body.expectedRevision !== current.revision) return Response.json(current, { status: 409 })
      const next = { revision: current.revision + 1, value: body.value }
      rows.set(key, next)
      controls.writes++
      if (controls.lostAck) {
        controls.lostAck = false
        return new Response("Acknowledgement lost", { status: 503 })
      }
      return Response.json(next)
    },
  })
  cleanup.push(() => server.stop(true))
  const clients: CentralState[] = []
  const client = () => {
    const next = createCentralState({ url: server.url.toString(), userID: "alice", fetch, debounceMs: 60_000 })
    clients.push(next)
    cleanup.push(() => next.dispose())
    return next
  }
  return { client, controls, rows, url: server.url.toString() }
}

const address = stateAddress({ storage: "workspace", key: "session:one:prompt" })

describe("central browser persistence over HTTP", () => {
  test("two clients hydrate the same value and resolve revision conflicts explicitly", async () => {
    const service = fixture()
    const first = service.client()
    const second = service.client()
    const a = first.storage(address)
    const b = second.storage(address)
    expect(await a.getItem("ignored")).toBeNull()
    expect(await b.getItem("ignored")).toBeNull()
    await a.setItem("ignored", '{"text":"first"}')
    expect(first.snapshots()[0].status).toBe("pending")
    await first.flush()
    expect(first.snapshots()[0].status).toBe("saved")
    await b.setItem("ignored", '{"text":"second"}')
    await expect(second.flush()).rejects.toBeInstanceOf(StateConflictError)
    expect(second.snapshots()[0]).toMatchObject({
      status: "conflict",
      value: '{"text":"second"}',
      remote: { revision: 1, value: '{"text":"first"}' },
    })
    await second.resolve(address, "local")
    expect(second.snapshots()[0]).toMatchObject({ status: "saved", revision: 2, value: '{"text":"second"}' })
    expect(await service.client().storage(address).getItem("ignored")).toBe('{"text":"second"}')
  })

  test("network failure leaves the exact draft pending in memory until acknowledged", async () => {
    const service = fixture()
    const client = service.client()
    const storage = client.storage(address)
    await storage.getItem("")
    service.controls.offline = true
    await storage.setItem("", '{"text":"unsaved","images":["data:image/png;base64,ABC"]}')
    await expect(client.flush()).rejects.toThrow("503")
    expect(client.dirty()).toBe(true)
    expect(client.snapshots()[0]).toMatchObject({
      status: "error",
      revision: 0,
      value: '{"text":"unsaved","images":["data:image/png;base64,ABC"]}',
    })
    expect(service.rows.size).toBe(0)
    service.controls.offline = false
    await client.retry(address)
    expect(client.dirty()).toBe(false)
    expect(client.snapshots()[0].status).toBe("saved")
    expect(await service.client().storage(address).getItem("")).toContain("data:image/png;base64,ABC")
  })

  test("retry reconciles a lost server acknowledgement without a duplicate revision", async () => {
    const service = fixture()
    const client = service.client()
    const storage = client.storage(address)
    await storage.getItem("")
    service.controls.lostAck = true
    await storage.setItem("", '{"text":"once"}')
    await expect(client.flush()).rejects.toThrow("503")
    expect(service.controls.writes).toBe(1)
    await client.retry(address)
    expect(client.snapshots()[0]).toMatchObject({ status: "saved", revision: 1 })
    expect(service.controls.writes).toBe(1)
  })

  test("conflict resolution using the server version rehydrates the mounted store", async () => {
    const service = fixture()
    const first = service.client()
    const second = service.client()
    await Promise.all([first.storage(address).getItem(""), second.storage(address).getItem("")])
    await first.storage(address).setItem("", '{"text":"server"}')
    await first.flush()
    await second.storage(address).setItem("", '{"text":"local"}')
    await expect(second.flush()).rejects.toBeInstanceOf(StateConflictError)
    const updates: Array<string | null> = []
    second.watch(address, (value) => updates.push(value))
    await second.resolve(address, "remote")
    expect(updates).toEqual(['{"text":"server"}'])
    expect(second.dirty()).toBe(false)
    expect(service.controls.writes).toBe(1)
  })

  test("coalesces rapid draft changes and preserves deletion revisions", async () => {
    const service = fixture()
    const first = service.client()
    const second = service.client()
    await Promise.all([first.storage(address).getItem(""), second.storage(address).getItem("")])
    await Promise.all(
      Array.from({ length: 100 }, (_, index) => first.storage(address).setItem("", JSON.stringify({ text: index }))),
    )
    await first.flush()
    expect(service.controls.writes).toBe(1)
    await first.storage(address).removeItem("")
    await first.flush()
    expect(first.snapshots()[0]).toMatchObject({ revision: 2, value: null, status: "saved" })
    await second.storage(address).setItem("", '{"text":"stale"}')
    await expect(second.flush()).rejects.toBeInstanceOf(StateConflictError)
    expect(second.snapshots()[0].remote).toEqual({ revision: 2, value: null })
  })

  test("refresh hydrates another browser's changes and never discards an in-flight edit", async () => {
    const service = fixture()
    const first = service.client()
    const second = service.client()
    await Promise.all([first.storage(address).getItem(""), second.storage(address).getItem("")])
    await first.storage(address).setItem("", '{"text":"new"}')
    await first.flush()
    const updates: Array<string | null> = []
    second.watch(address, (value) => updates.push(value))
    await second.refresh()
    expect(updates).toEqual(['{"text":"new"}'])
    await first.storage(address).setItem("", '{"text":"newer"}')
    await first.flush()
    const release = Promise.withResolvers<void>()
    service.controls.delayRead = release.promise
    const refreshing = second.refresh()
    await second.storage(address).setItem("", '{"text":"typing"}')
    release.resolve()
    await refreshing
    expect(second.snapshots()[0].value).toBe('{"text":"typing"}')
    expect(updates).toEqual(['{"text":"new"}', '{"text":"typing"}'])
    await expect(second.flush()).rejects.toBeInstanceOf(StateConflictError)
  })

  test("disposed account clients cannot write through a newly active cookie", async () => {
    const service = fixture()
    const client = service.client()
    await client.storage(address).getItem("")
    client.dispose()
    await expect(client.storage(address).setItem("", '{"text":"old account"}')).rejects.toThrow("no longer active")
    expect(service.controls.writes).toBe(0)
  })

  test("bootstrap establishes verified server and user identity before central state is enabled", async () => {
    const service = fixture()
    await bootstrapCentralState({ url: service.url, fetch, requireCentral: true })
    expect(centralRuntime.get()).toMatchObject({ mode: "central", user: { id: "alice" } })
    expect(centralRuntime.get().client?.userID).toBe("alice")
  })

  test("the real persisted bridge rehydrates, saves, and retains unsaved state across remounts", async () => {
    const service = fixture()
    const client = service.client()
    centralRuntime.configure({
      mode: "central",
      url: service.url,
      user: { id: "alice", username: "Alice", email: "alice@example.test" },
      client,
    })
    const target = { storage: "workspace", key: "session:one:prompt" }
    const mount = () =>
      createRoot((dispose) => {
        cleanup.push(dispose)
        return persistedCentral(target, createStore({ text: "", mode: "normal" }), { text: "", mode: "normal" })
      })
    const first = mount()
    expect(first[3]()).toBe(false)
    await first[2]
    expect(first[3]()).toBe(true)
    first[1]("text", "Still typing")
    const second = mount()
    await second[2]
    expect(second[0].text).toBe("Still typing")
    expect(service.controls.writes).toBe(0)
    await client.flush()
    expect(JSON.parse((await service.client().storage(address).getItem(""))!)).toEqual({
      text: "Still typing",
      mode: "normal",
    })
  })

  test("external snapshots replace changed array references and preserve unchanged ones", async () => {
    const service = fixture()
    const client = service.client()
    centralRuntime.configure({
      mode: "central",
      url: service.url,
      user: { id: "alice", username: "Alice", email: "alice@example.test" },
      client,
    })
    const defaults = { prompt: [{ content: "" }], mode: "normal" }
    const state = createRoot((dispose) => {
      cleanup.push(dispose)
      return persistedCentral({ storage: "workspace", key: "session:one:prompt" }, createStore(defaults), defaults)
    })
    await state[2]
    state[1]("prompt", [{ content: "local draft" }])
    await client.flush()
    const previous = state[0].prompt
    const second = service.client()
    await second.storage(address).getItem("")
    await second.storage(address).setItem("", JSON.stringify({ prompt: [{ content: "remote draft" }], mode: "normal" }))
    await second.flush()
    await client.refresh()
    expect(state[0].prompt).not.toBe(previous)
    expect(state[0].prompt[0]?.content).toBe("remote draft")
    const updated = state[0].prompt
    await second.storage(address).setItem("", JSON.stringify({ prompt: [{ content: "remote draft" }], mode: "shell" }))
    await second.flush()
    await client.refresh()
    expect(state[0].prompt).toBe(updated)
    expect(state[0].mode).toBe("shell")
  })

  test("failed initial hydration remains pending, preserves edits, and becomes ready after retry", async () => {
    const service = fixture()
    const seed = service.client()
    await seed.storage(address).getItem("")
    await seed.storage(address).setItem("", '{"text":"remote","mode":"shell"}')
    await seed.flush()
    const client = service.client()
    centralRuntime.configure({
      mode: "central",
      url: service.url,
      user: { id: "alice", username: "Alice", email: "alice@example.test" },
      client,
    })
    service.controls.offline = true
    const state = createRoot((dispose) => {
      cleanup.push(dispose)
      return persistedCentral(
        { storage: "workspace", key: "session:one:prompt" },
        createStore({ text: "", mode: "normal" }),
        { text: "", mode: "normal" },
      )
    })
    state[1]("text", "queued while offline")
    await expect(client.storage(address).getItem("")).rejects.toThrow("503")
    expect(state[3]()).toBe(false)
    expect(client.dirty()).toBe(true)
    await expect(client.flush()).rejects.toThrow("still loading")
    service.controls.offline = false
    await client.retry(address)
    await state[3].promise
    await client.flush()
    expect(state[0]).toEqual({ text: "queued while offline", mode: "shell" })
    expect(state[3]()).toBe(true)
    expect(client.dirty()).toBe(false)
  })

  test("another account's cookie cannot receive a previous account's pending drafts", async () => {
    const service = fixture()
    const client = service.client()
    await client.storage(address).getItem("")
    await client.storage(address).setItem("", '{"text":"Alice private draft"}')
    service.controls.userID = "bob"
    await expect(client.flush()).rejects.toThrow("session expired")
    expect(service.controls.writes).toBe(0)
    expect(client.snapshots()[0].status).toBe("error")
    expect(client.dirty()).toBe(true)
  })

  test("explicit browser migration deletes only acknowledged copies and excludes credentials", async () => {
    const service = fixture()
    const client = service.client()
    const source = new Map([
      ["settings.v3", '{"editor":{"fontSize":14}}'],
      ["opencode.global.dat:prompt-history", '{"entries":["saved"]}'],
      ["omai_auth_token", "secret"],
      ["opencode.global.dat:server", '{"password":"secret"}'],
      ["unrelated-model", '{"value":"leave alone"}'],
    ])
    const storage: Storage = {
      get length() {
        return source.size
      },
      key: (index) => [...source.keys()][index] ?? null,
      getItem: (key) => source.get(key) ?? null,
      setItem: (key, value) => {
        source.set(key, value)
      },
      removeItem: (key) => {
        source.delete(key)
      },
      clear: () => source.clear(),
    }
    service.controls.offline = true
    expect(await importBrowserState(client, storage)).toEqual({ imported: 0, existing: 0, failed: 2 })
    expect(source.size).toBe(5)
    service.controls.offline = false
    expect(await importBrowserState(client, storage)).toEqual({ imported: 2, existing: 0, failed: 0 })
    expect([...source.keys()]).toEqual(["omai_auth_token", "opencode.global.dat:server", "unrelated-model"])
    expect(service.controls.writes).toBe(2)
  })

  test("hosted preview normalization preserves isolation and one-use capability query", () => {
    expect(
      previewUrl(
        "https://preview.example.test/global/preview/proxy/3000/?ticket=one-use",
        "https://app.example.test",
        true,
      ),
    ).toBe("https://preview.example.test/global/preview/proxy/3000/?ticket=one-use")
    expect(() => previewUrl("https://app.example.test/preview", "https://app.example.test", true)).toThrow(
      "separate HTTP origin",
    )
    expect(() => previewUrl("javascript:alert(1)", "https://app.example.test", true)).toThrow("separate HTTP origin")
    expect(previewUrl("http://127.0.0.1:4096/preview/3000", "https://local.example.test", false)).toBe(
      "https://local.example.test/preview/3000",
    )
  })

  test("idle state is not polled and unchanged values are not rewritten", async () => {
    const service = fixture()
    const client = service.client()
    const storage = client.storage(address)
    await storage.getItem("")
    const hydrated = service.controls.requests
    await client.refresh()
    expect(service.controls.requests).toBe(hydrated)

    const stopWatching = client.watch(address, () => undefined)
    await client.refresh()
    expect(service.controls.requests).toBe(hydrated + 1)

    await storage.setItem("", '{"text":"once"}')
    await client.flush()
    expect(service.controls.writes).toBe(1)
    const afterWrite = service.controls.requests
    await storage.setItem("", '{"text":"once"}')
    await client.flush()
    expect(service.controls.writes).toBe(1)
    expect(service.controls.requests).toBe(afterWrite)

    stopWatching()
    await client.refresh()
    expect(service.controls.requests).toBe(afterWrite)
  })

  test("recover backs off failed reads instead of retrying on every tick", async () => {
    const service = fixture()
    const client = service.client()
    const stopWatching = client.watch(address, () => undefined)
    service.controls.offline = true
    await client.storage(address).getItem("").catch(() => undefined)
    expect(client.snapshots()[0].status).toBe("error")
    const attempts = service.controls.requests
    client.recover()
    expect(service.controls.requests).toBe(attempts)

    service.controls.offline = false
    await client.retry(address)
    expect(client.snapshots()[0].status).toBe("saved")
    stopWatching()
  })

  test("addressing is collision-free and PostgreSQL text safe for scoped keys", () => {
    const target = stateAddress({ storage: "a", key: "https://server\u0000session:one:prompt" })
    expect(target.namespace).toBe("drafts")
    expect(target.key).not.toContain("\u0000")
    expect(target.key).not.toBe(stateAddress({ storage: "", key: "a:https://server\u0000session:one:prompt" }).key)
    expect(JSON.parse(target.key)).toEqual(["a", "https://server\u0000session:one:prompt"])
  })
})
