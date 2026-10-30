import { afterEach, expect, mock, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { PublishDeploymentTable } from "@opencode-ai/core/publish/sql"
import { Context, Effect } from "effect"
import { eq } from "drizzle-orm"
import path from "path"

if (process.env.OPENCODE_TEST_PUBLISH_WORKER !== "1") {
  test("publish handlers persist successful deployments through native PostgreSQL", async () => {
    // Module substitutions stay inside the isolated child process. Only the paid provider
    // boundary is substituted; routing, project setup, files and PostgreSQL are real.
    const child = Bun.spawn([process.execPath, "test", "--timeout", "15000", import.meta.path], {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, OPENCODE_TEST_PUBLISH_WORKER: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).toBe(0)
  }, 30_000)
} else {
  const deployments: { id: string; name: string }[] = []
  const unexpected = () => Effect.die("Unexpected Cloudflare operation in the persistence regression")
  mock.module("../../src/publish/cloudflare-pages", () => ({
    createOrUpdateProject: (name: string) => Effect.succeed({ name }),
    createDeployment: (name: string, files: Map<string, Buffer>) =>
      Effect.sync(() => {
        expect(files.get("index.html")?.toString()).toBe("<h1>Local publishing fixture</h1>")
        const deployment = { id: `test-deployment-${deployments.length + 1}`, name }
        deployments.push(deployment)
        return deployment
      }),
    deleteProject: unexpected,
    addCustomDomain: unexpected,
    getCustomDomain: unexpected,
    deleteCustomDomain: unexpected,
  }))
  const workerCalls: string[] = []
  const platformCalls: string[] = []
  const domainCalls: string[] = []
  const platformFail = { current: false }
  // Ordered log of name-claim, build and cleanup calls, plus the owner tag per claimed script.
  const claimCalls: string[] = []
  const owners = new Map<string, string>()
  const staleReads = { current: 0 }
  const claimOverride = { current: undefined as string | undefined }
  const dnsTaken = new Set<string>()
  const saasEnabled = { current: false }
  class CloudflareError extends Error {
    constructor(
      readonly status: number,
      readonly codes: number[],
      readonly body: string,
    ) {
      super(body)
    }
  }
  mock.module("../../src/publish/platform-build", () => ({
    PlatformBuild: {
      deployToPlatform: (_directory: string, name: string) =>
        Effect.suspend(() => {
          platformCalls.push(name)
          claimCalls.push(`deploy:${name}`)
          if (platformFail.current) return Effect.fail(new Error("platform build failed"))
          return Effect.succeed({ id: `platform-${platformCalls.length}`, url: `https://${name}.omai.ch` })
        }),
    },
  }))
  mock.module("../../src/publish/cloudflare-platform", () => ({
    CloudflarePlatform: {
      PLATFORM: { zone: "omai.ch", namespace: "omai-apps", dispatcher: "omai-dispatcher", kvTitle: "omai-hostnames" },
      CloudflareError,
      isSaasDisabledError: (e: unknown) =>
        e instanceof CloudflareError && e.codes.some((code) => code === 1404 || code === 1456),
      isStatus: (e: unknown, status: number) => e instanceof CloudflareError && e.status === status,
      scriptExists: (name: string) => Effect.sync(() => owners.has(name)),
      hostnameHasRecord: (name: string) => Effect.sync(() => dnsTaken.has(name)),
      claimScript: (name: string, projectID: string) =>
        Effect.sync(() => {
          claimCalls.push(`claim:${name}`)
          owners.set(name, claimOverride.current ?? projectID)
        }),
      scriptOwner: (name: string) =>
        Effect.sync(() => {
          if (staleReads.current > 0) {
            staleReads.current--
            return undefined
          }
          return owners.get(name)
        }),
      ensurePlatform: () => Effect.void,
      ensureFallbackOrigin: () => Effect.void,
      addCustomHostname: (hostname: string) =>
        saasEnabled.current
          ? Effect.sync(() => (domainCalls.push(`addCustomHostname:${hostname}`), { id: "ch_1", hostname }))
          : Effect.fail(new CloudflareError(403, [1404], "SaaS disabled")),
      getCustomHostname: () => Effect.succeed(undefined),
      deleteCustomHostname: () => Effect.void,
      putHostname: (hostname: string, script: string) =>
        Effect.sync(() => void domainCalls.push(`putHostname:${hostname}->${script}`)),
      deleteHostname: () => Effect.void,
      addRoute: () => Effect.sync(() => (domainCalls.push("addRoute"), "route")),
      deleteRouteByPattern: () => Effect.void,
      deleteScript: (name: string) =>
        Effect.sync(() => {
          claimCalls.push(`delete:${name}`)
          owners.delete(name)
        }),
      domainStatus: () => "pending",
    },
  }))
  mock.module("../../src/publish/cloudflare-workers", () => ({
    deployToWorkers: (_directory: string, name: string) =>
      Effect.sync(() => {
        workerCalls.push(name)
        return { id: `worker-${workerCalls.length}`, url: `https://${name}.example.workers.dev`, name }
      }),
    deleteWorkerScript: unexpected,
    addWorkerDomain: unexpected,
    listWorkerDomains: unexpected,
    removeWorkerDomain: unexpected,
    setupZone: unexpected,
    getZoneByName: unexpected,
  }))
  process.env.CLOUDFLARE_API_TOKEN = "local-test-provider-boundary"
  process.env.CLOUDFLARE_ACCOUNT_ID = "local-test-account"

  const { HttpApiApp } = await import("../../src/server/routes/instance/httpapi/server")
  const { PlatformName } = await import("../../src/publish/platform-name")
  const { disposeAllInstances, tmpdir } = await import("../fixture/fixture")
  afterEach(disposeAllInstances)

  const request = (route: string, directory: string, payload: object) =>
    HttpApiApp.webHandler().handler(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": directory },
        body: JSON.stringify(payload),
      }),
      Context.empty() as Context.Context<unknown>,
    )
  const rows = () =>
    Effect.runPromise(
      Database.Service.use(({ db }) => db.select().from(PublishDeploymentTable)).pipe(
        Effect.provide(Database.layerFromConfig(Database.configFromEnvironment())),
        Effect.scoped,
      ),
    )

  test("deploy to the platform inserts a row and a second deploy updates it", async () => {
    await using directory = await tmpdir({ git: true })
    const calls = platformCalls.length
    const created = await request("/publish", directory.path, { directory: directory.path })
    expect(created.status).toBe(200)
    const first = await rows()
    const name = PlatformName.slug(path.basename(directory.path))
    expect(first).toHaveLength(1)
    expect(first[0]?.runtime).toBe("platform")
    expect(first[0]?.url).toBe(`https://${name}.omai.ch`)
    expect(platformCalls.length).toBe(calls + 1)
    expect(claimCalls.slice(-2)).toEqual([`claim:${name}`, `deploy:${name}`])

    const updated = await request("/publish", directory.path, { directory: directory.path })
    expect(updated.status).toBe(200)
    const second = await rows()
    expect(second).toHaveLength(1)
    expect(second[0]?.id).toBe(first[0]?.id)
    expect(second[0]?.cf_project_name).toBe(first[0]?.cf_project_name)
    expect(second[0]?.cf_deployment_id).not.toBe(first[0]?.cf_deployment_id)
  })

  test("a stale claim read-back is retried until the tag shows", async () => {
    await using directory = await tmpdir({ git: true })
    staleReads.current = 2
    const created = await request("/publish", directory.path, { directory: directory.path })
    expect(created.status).toBe(200)
    expect(staleReads.current).toBe(0)
    expect(await rows()).toHaveLength(1)
  })

  test("a claim lost to another project fails without deleting its script", async () => {
    await using directory = await tmpdir({ git: true })
    const name = PlatformName.slug(path.basename(directory.path))
    claimOverride.current = "omai-project-other"
    const created = await request("/publish", directory.path, { directory: directory.path })
    claimOverride.current = undefined
    expect(created.status).toBe(400)
    expect(await created.text()).toContain("That app name was just taken.")
    expect(claimCalls).not.toContain(`delete:${name}`)
    expect(owners.get(name)).toBe("omai-project-other")
    expect(await rows()).toHaveLength(0)
  })

  test("a failed platform deploy saves no row", async () => {
    await using directory = await tmpdir({ git: true })
    platformFail.current = true
    const response = await request("/publish", directory.path, { directory: directory.path }).finally(() => {
      platformFail.current = false
    })
    expect(response.status).not.toBe(200)
    expect(await rows()).toHaveLength(0)
    const name = PlatformName.slug(path.basename(directory.path))
    expect(claimCalls.slice(-3)).toEqual([`claim:${name}`, `deploy:${name}`, `delete:${name}`])
    expect(owners.has(name)).toBe(false)
  })

  test("a name with an existing DNS record is treated as taken", async () => {
    await using directory = await tmpdir({ git: true })
    const base = PlatformName.slug(path.basename(directory.path))
    dnsTaken.add(base)
    const response = await request("/publish", directory.path, { directory: directory.path })
    expect(response.status).toBe(200)
    const [row] = await rows()
    expect(row?.cf_project_name).not.toBe(base)
    expect(row?.cf_project_name.startsWith(base.slice(0, 35).replace(/-+$/, ""))).toBe(true)
  })

  test("redeploy and delete refuse a script owned by another project", async () => {
    await using directory = await tmpdir({ git: true })
    await request("/publish", directory.path, { directory: directory.path })
    const [row] = await rows()
    owners.set(row!.cf_project_name, "someone-else")
    const calls = platformCalls.length
    const redeploy = await request("/publish/redeploy", directory.path, { id: row!.id, directory: directory.path })
    expect(redeploy.status).toBe(400)
    expect(await redeploy.text()).toContain("This app belongs to another project.")
    const deploy = await request("/publish", directory.path, { directory: directory.path })
    expect(deploy.status).toBe(400)
    expect(platformCalls.length).toBe(calls)
    const removed = await request("/publish/delete", directory.path, { id: row!.id })
    expect(removed.status).toBe(400)
    expect(await removed.text()).toContain("This app belongs to another project.")
    expect(owners.get(row!.cf_project_name)).toBe("someone-else")
    expect(await rows()).toHaveLength(1)
  })

  test("platform custom domains reject malformed hostnames", async () => {
    await using directory = await tmpdir({ git: true })
    await request("/publish", directory.path, { directory: directory.path })
    const [row] = await rows()
    const bad = await request("/publish/domain", directory.path, { deployment_id: row!.id, domain: "not a domain" })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain("Enter a valid domain like app.example.com.")
  })

  test("platform custom domains report SaaS disabled and reject domains inside the zone", async () => {
    await using directory = await tmpdir({ git: true })
    await request("/publish", directory.path, { directory: directory.path })
    const [row] = await rows()
    const disabled = await request("/publish/domain", directory.path, { deployment_id: row!.id, domain: "example.com" })
    expect(disabled.status).toBe(400)
    expect(await disabled.text()).toContain("Custom domains aren't enabled yet.")
    expect((await rows())[0]?.custom_domain).toBeNull()
    expect(domainCalls).toEqual([])

    const inside = await request("/publish/domain", directory.path, { deployment_id: row!.id, domain: "foo.omai.ch" })
    expect(inside.status).toBe(400)
    expect(await inside.text()).toContain("Custom domains must be outside omai.ch.")
  })

  test("platform custom domains map the hostname to the app without adding a route", async () => {
    await using directory = await tmpdir({ git: true })
    await request("/publish", directory.path, { directory: directory.path })
    const [row] = await rows()
    saasEnabled.current = true
    domainCalls.length = 0
    try {
      const added = await request("/publish/domain", directory.path, { deployment_id: row!.id, domain: "app.example.com" })
      expect(added.status).toBe(200)
      expect(await added.json()).toMatchObject({
        domain: "app.example.com",
        status: "pending",
        cname_target: `${row!.cf_project_name}.omai.ch`,
      })
      // Cloudflare rejects a route outside the zone; the zone's `*/*` route serves it.
      expect(domainCalls).toEqual([
        "addCustomHostname:app.example.com",
        `putHostname:app.example.com->${row!.cf_project_name}`,
      ])
      expect((await rows())[0]).toMatchObject({ custom_domain: "app.example.com", custom_domain_status: "pending" })
    } finally {
      saasEnabled.current = false
    }
  })

  test("recovered redeploy never creates a platform row", async () => {
    await using directory = await tmpdir({ git: true })
    await Bun.write(`${directory.path}/index.html`, "<h1>Local publishing fixture</h1>")
    const calls = platformCalls.length
    const response = await request("/publish/redeploy", directory.path, {
      id: "pub_forged",
      name: "x",
      directory: directory.path,
      runtime: "platform",
    })
    expect(platformCalls.length).toBe(calls)
    expect((await rows()).every((row) => row.runtime !== "platform")).toBe(true)
    if (response.status === 200) expect((await rows())[0]?.runtime).toBe("pages")
  })

  test("redeploy of a legacy row keeps using the Workers path", async () => {
    await using directory = await tmpdir({ git: true })
    await request("/publish", directory.path, { directory: directory.path })
    const [row] = await rows()
    await Effect.runPromise(
      Database.Service.use(({ db }) =>
        db
          .update(PublishDeploymentTable)
          .set({ runtime: null, url: "https://x.y.workers.dev", cf_project_name: "legacy-app" })
          .where(eq(PublishDeploymentTable.id, row!.id))
          .execute(),
      ).pipe(Effect.provide(Database.layerFromConfig(Database.configFromEnvironment())), Effect.scoped),
    )
    const platform = platformCalls.length
    const response = await request("/publish/redeploy", directory.path, { id: row!.id, directory: directory.path })
    expect(response.status).toBe(200)
    expect(workerCalls).toEqual(["legacy-app"])
    expect(platformCalls.length).toBe(platform)
  })

  test("redeploy inserts a recovered deployment and updates it on the next request", async () => {
    await using directory = await tmpdir({ git: true })
    await Bun.write(`${directory.path}/index.html`, "<h1>Local publishing fixture</h1>")
    const payload = { id: "pub_recovered", name: "omai-recovered", directory: directory.path, runtime: "pages" }
    const created = await request("/publish/redeploy", directory.path, payload)
    expect(created.status).toBe(200)
    const first = await rows()
    expect(first).toHaveLength(1)
    expect(first[0]?.id).toBe(payload.id)
    expect(first[0]?.cf_deployment_id).toBe(deployments.at(-1)!.id)

    const updated = await request("/publish/redeploy", directory.path, payload)
    expect(updated.status).toBe(200)
    const second = await rows()
    expect(second).toHaveLength(1)
    expect(second[0]?.id).toBe(payload.id)
    expect(second[0]?.cf_deployment_id).toBe(deployments.at(-1)!.id)
    expect(second[0]?.cf_deployment_id).not.toBe(first[0]?.cf_deployment_id)
  })
}
