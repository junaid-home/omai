import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError, InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const PublishBody = Schema.Struct({
  directory: Schema.optional(Schema.String),
})

export const PublishRedeployBody = Schema.Struct({
  id: Schema.String,
  directory: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
})

export const PublishDeleteBody = Schema.Struct({
  id: Schema.String,
})

export const PublishAddDomainBody = Schema.Struct({
  deployment_id: Schema.String,
  domain: Schema.String,
})

export const PublishSetupZoneBody = Schema.Struct({
  domain: Schema.String,
})

export const ZoneResponse = Schema.Struct({
  status: Schema.String,
  name: Schema.optional(Schema.String),
  name_servers: Schema.optional(Schema.Array(Schema.String)),
  message: Schema.optional(Schema.String),
})

export const PublishRemoveDomainBody = Schema.Struct({
  deployment_id: Schema.String,
  domain: Schema.String,
})

export const PublishVerifyDomainBody = Schema.Struct({
  domain: Schema.String,
})

export const VerifyDomainResponse = Schema.Struct({
  domain: Schema.String,
  cname_ok: Schema.Boolean,
  nameservers_ok: Schema.Boolean,
  cname_target: Schema.String,
  expected_nameservers: Schema.Array(Schema.String),
  status: Schema.String,
})

export const CustomDomainResponse = Schema.Struct({
  domain: Schema.String,
  status: Schema.String,
  cname_target: Schema.String,
  nameservers: Schema.optional(Schema.Array(Schema.String)),
})

export const PublishDomainListResponse = Schema.Array(CustomDomainResponse)

export const PublishDeploymentResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  label: Schema.String,
  url: Schema.String,
  status: Schema.String,
  runtime: Schema.optional(Schema.String),
  created_at: Schema.Number,
})

export const PublishListResponse = Schema.Array(PublishDeploymentResponse)

export const PublishResultResponse = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  name: Schema.String,
  status: Schema.String,
  runtime: Schema.optional(Schema.String),
})

export const PublishPaths = {
  deploy: "/publish",
  list: "/publish",
  redeploy: "/publish/redeploy",
  delete: "/publish/delete",
  addDomain: "/publish/domain",
  listDomains: "/publish/domain",
  removeDomain: "/publish/domain/remove",
  setupZone: "/publish/zone",
  verifyDomain: "/publish/domain/verify",
} as const

export const PublishApi = HttpApi.make("publish")
  .add(
    HttpApiGroup.make("publish")
      .add(
        HttpApiEndpoint.post("deploy", PublishPaths.deploy, {
          query: WorkspaceRoutingQuery,
          payload: PublishBody,
          success: described(PublishResultResponse, "Publish result"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.deploy",
            summary: "Deploy project",
            description: "Deploy the current project to Cloudflare Pages and make it accessible on the internet.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("list", PublishPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(PublishListResponse, "List of deployments"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.list",
            summary: "List deployments",
            description: "List all deployments for the current project.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("redeploy", PublishPaths.redeploy, {
          query: WorkspaceRoutingQuery,
          payload: PublishRedeployBody,
          success: described(PublishResultResponse, "Redeploy result"),
          error: [ApiNotFoundError, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.redeploy",
            summary: "Redeploy",
            description: "Redeploy an existing deployment.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("delete", PublishPaths.delete, {
          query: WorkspaceRoutingQuery,
          payload: PublishDeleteBody,
          success: described(Schema.Struct({ success: Schema.Boolean }), "Success"),
          error: [ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.delete",
            summary: "Delete deployment",
            description: "Delete a deployment and remove it from Cloudflare Pages.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("addDomain", PublishPaths.addDomain, {
          query: WorkspaceRoutingQuery,
          payload: PublishAddDomainBody,
          success: described(CustomDomainResponse, "Custom domain added"),
          error: [ApiNotFoundError, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.addDomain",
            summary: "Add custom domain",
            description: "Attach a custom domain to a Cloudflare Pages deployment.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("listDomains", PublishPaths.listDomains, {
          query: WorkspaceRoutingQuery,
          success: described(PublishDomainListResponse, "Custom domains"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.listDomains",
            summary: "List custom domains",
            description: "List custom domains attached to the current project's deployment.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("removeDomain", PublishPaths.removeDomain, {
          query: WorkspaceRoutingQuery,
          payload: PublishRemoveDomainBody,
          success: described(Schema.Struct({ success: Schema.Boolean }), "Success"),
          error: [ApiNotFoundError, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.removeDomain",
            summary: "Remove custom domain",
            description: "Detach a custom domain from a Cloudflare Pages deployment.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("setupZone", PublishPaths.setupZone, {
          query: WorkspaceRoutingQuery,
          payload: PublishSetupZoneBody,
          success: described(ZoneResponse, "Zone setup result"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.setupZone",
            summary: "Setup Cloudflare zone",
            description: "Add a domain to Cloudflare and return nameservers for DNS configuration.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("verifyDomain", PublishPaths.verifyDomain, {
          query: WorkspaceRoutingQuery,
          payload: PublishVerifyDomainBody,
          success: described(VerifyDomainResponse, "Domain verification result"),
          error: [InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "publish.verifyDomain",
            summary: "Verify domain DNS",
            description: "Verify that a custom domain's CNAME and nameserver DNS records are correctly configured.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "publish",
          description: "Publish routes for deploying projects to the internet.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "OMAI+ publish HttpApi",
      version: "0.0.1",
      description: "Publish HttpApi surface for deploying projects.",
    }),
  )
