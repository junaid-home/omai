import { afterEach, expect, mock, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { PublishDeploymentTable } from "@opencode-ai/core/publish/sql"
import { Context, Effect } from "effect"

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
  mock.module("../../src/publish/cloudflare-workers", () => ({
    deployToWorkers: unexpected,
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

  test("deploy inserts a row and subsequent deploy updates that row", async () => {
    await using directory = await tmpdir({ git: true })
    await Bun.write(`${directory.path}/index.html`, "<h1>Local publishing fixture</h1>")
    const created = await request("/publish", directory.path, { directory: directory.path })
    expect(created.status).toBe(200)
    const first = await rows()
    expect(first).toHaveLength(1)
    expect(first[0]?.cf_deployment_id).toBe(deployments.at(-1)!.id)
    expect(first[0]?.runtime).toBe("pages")

    const updated = await request("/publish", directory.path, { directory: directory.path })
    expect(updated.status).toBe(200)
    const second = await rows()
    expect(second).toHaveLength(1)
    expect(second[0]?.id).toBe(first[0]?.id)
    expect(second[0]?.cf_deployment_id).toBe(deployments.at(-1)!.id)
    expect(second[0]?.cf_deployment_id).not.toBe(first[0]?.cf_deployment_id)
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
