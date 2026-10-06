import { Effect } from "effect"
import { array, check, object } from "./assertions"
import { http } from "./dsl"

// These manifest scenarios cover the actual no-provider and not-found contracts.
// Provider-success persistence is exercised separately by httpapi-publish-persistence.test.ts.
// Never inherit real deployment credentials into a route that can create billable resources.
function withoutCloudflare() {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = new Map(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].map((key) => [key, process.env[key]]))
      for (const key of previous.keys()) delete process.env[key]
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

function configurationError(body: unknown) {
  object(body)
  check(body.kind === "configuration", "unconfigured publishing must return a typed configuration error")
  check(
    typeof body.message === "string" &&
      body.message.includes("CLOUDFLARE_API_TOKEN") &&
      body.message.includes("CLOUDFLARE_ACCOUNT_ID"),
    "error must identify missing configuration",
  )
}

function noDeployment(body: unknown) {
  object(body)
  object(body.data)
  check(
    body.name === "NotFoundError" && body.data.message === "Deployment not found",
    "missing deployment must produce the domain not-found error",
  )
}

export const publishScenarios = [
  http.protected.get("/publish", "omai.publish.list").json(200, (body) => {
    array(body)
    check(body.length === 0, "fresh project should have no deployments")
  }),
  http.protected.get("/publish/domain", "omai.publish.domains").json(200, (body) => {
    array(body)
    check(body.length === 0, "fresh project should have no custom domains")
  }),
  http.protected
    .post("/publish", "omai.publish.deploy.unconfigured")
    .seeded(withoutCloudflare)
    .at((ctx) => ({ path: "/publish", headers: ctx.headers(), body: { directory: ctx.directory } }))
    .json(400, configurationError),
  http.protected
    .post("/publish/redeploy", "omai.publish.redeploy.unconfigured")
    .seeded(withoutCloudflare)
    .at((ctx) => ({
      path: "/publish/redeploy",
      headers: ctx.headers(),
      body: { id: "pub_httpapi_missing", directory: ctx.directory },
    }))
    .json(400, configurationError),
  http.protected
    .post("/publish/delete", "omai.publish.delete.missing")
    .seeded(withoutCloudflare)
    .at((ctx) => ({ path: "/publish/delete", headers: ctx.headers(), body: { id: "pub_httpapi_missing" } }))
    .json(404, noDeployment),
  http.protected
    .post("/publish/domain", "omai.publish.domain.add.unconfigured")
    .seeded(withoutCloudflare)
    .at((ctx) => ({
      path: "/publish/domain",
      headers: ctx.headers(),
      body: { deployment_id: "pub_httpapi_missing", domain: "site.example.test" },
    }))
    .json(400, configurationError),
  http.protected
    .post("/publish/domain/remove", "omai.publish.domain.remove.missing")
    .seeded(withoutCloudflare)
    .at((ctx) => ({
      path: "/publish/domain/remove",
      headers: ctx.headers(),
      body: { deployment_id: "pub_httpapi_missing", domain: "site.example.test" },
    }))
    .json(404, noDeployment),
  http.protected
    .post("/publish/domain/verify", "omai.publish.domain.verify.unconfigured")
    .seeded(withoutCloudflare)
    .at((ctx) => ({ path: "/publish/domain/verify", headers: ctx.headers(), body: { domain: "site.example.test" } }))
    .json(400, configurationError),
  http.protected
    .post("/publish/zone", "omai.publish.zone.unconfigured")
    .seeded(withoutCloudflare)
    .at((ctx) => ({ path: "/publish/zone", headers: ctx.headers(), body: { domain: "site.example.test" } }))
    .json(400, configurationError),
]
