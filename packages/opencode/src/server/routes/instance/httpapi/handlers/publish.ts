// @ts-nocheck
import * as InstanceState from "@/effect/instance-state"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { randomUUID } from "crypto"
import { promises as dnsPromises } from "dns"
import { PublishDeploymentTable } from "@opencode-ai/core/publish/sql"
import {
  createOrUpdateProject,
  createDeployment,
  deleteProject,
  addCustomDomain,
  getCustomDomain,
  deleteCustomDomain,
} from "@/publish/cloudflare-pages"
import {
  deployToWorkers,
  deleteWorkerScript,
  addWorkerDomain,
  listWorkerDomains,
  removeWorkerDomain,
  setupZone,
  getZoneByName,
} from "@/publish/cloudflare-workers"
import { CloudflarePlatform } from "@/publish/cloudflare-platform"
import { PlatformBuild } from "@/publish/platform-build"
import { PlatformName } from "@/publish/platform-name"
import { collectProjectFiles, resolveDeployDirectory } from "@/publish/collect"
import path from "path"
import { eq, inArray } from "drizzle-orm"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, notFound } from "../errors"

function requirePublishEnv(): Effect.Effect<void, InvalidRequestError> {
  const missing: string[] = []
  if (!process.env.CLOUDFLARE_API_TOKEN) missing.push("CLOUDFLARE_API_TOKEN")
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) missing.push("CLOUDFLARE_ACCOUNT_ID")
  if (missing.length > 0) {
    return Effect.fail(
      new InvalidRequestError({
        message: `Missing Cloudflare environment variables: ${missing.join(", ")}. Set them in your environment or your OMAI+ deployment secrets.`,
        kind: "configuration",
      }),
    )
  }
  return Effect.void
}

function cfError(err: unknown): InvalidRequestError {
  return new InvalidRequestError({
    message: String(err instanceof Error ? err.message : err),
    kind: "cloudflare",
  })
}

function platformError(err: unknown): InvalidRequestError {
  if (CloudflarePlatform.isSaasDisabledError(err))
    return new InvalidRequestError({ message: "Custom domains aren't enabled yet.", kind: "cloudflare" })
  return cfError(err)
}

// Each step tolerates "not found" so a partially removed domain can still be cleaned up.
function removePlatformDomain(domain: string) {
  return Effect.gen(function* () {
    const hostname = yield* CloudflarePlatform.getCustomHostname(domain)
    if (hostname)
      yield* CloudflarePlatform.deleteCustomHostname(hostname.id).pipe(
        Effect.catch((err) => (CloudflarePlatform.isStatus(err, 404) ? Effect.void : Effect.fail(err))),
      )
    yield* CloudflarePlatform.deleteHostname(domain)
  }).pipe(Effect.catch((err) => Effect.fail(cfError(err))))
}

function platformDomainState(row: { cf_project_name: string; custom_domain_status: string | null }, domain: string) {
  return Effect.gen(function* () {
    const hostname = yield* CloudflarePlatform.getCustomHostname(domain).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    const status = hostname ? CloudflarePlatform.domainStatus(hostname) : (row.custom_domain_status ?? "pending")
    return { status, target: `${row.cf_project_name}.${CloudflarePlatform.PLATFORM.zone}` }
  })
}

function saveError<A, R>(effect: Effect.Effect<A, Error, R>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new InvalidRequestError({
          message: `Failed to save deployment: ${error.message}`,
          kind: "configuration",
        }),
    ),
  )
}

/** Refuses to touch a platform script whose owner tag names a different project. A missing script is fine. */
function requireOwner(name: string, projectID: string) {
  return Effect.gen(function* () {
    const owner = yield* CloudflarePlatform.scriptOwner(name).pipe(Effect.catch((err) => Effect.fail(cfError(err))))
    if (owner !== undefined && owner !== projectID)
      return yield* new InvalidRequestError({ message: "This app belongs to another project.", kind: "configuration" })
  })
}

export const publishHandlers = HttpApiBuilder.group(InstanceHttpApi, "publish", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service

    const markLive = (id: string, result: { id: string; url: string }) =>
      database.db
        .update(PublishDeploymentTable)
        .set({ url: result.url, cf_deployment_id: result.id, status: "live", time_updated: Date.now() })
        .where(eq(PublishDeploymentTable.id, id))
        .execute()
        .pipe(saveError)

    const deploy = Effect.fn("PublishHttpApi.deploy")(function* (ctx: { payload: { directory?: string } }) {
      yield* requirePublishEnv()
      const context = yield* InstanceState.context

      if (!ctx.payload.directory) {
        return yield* Effect.fail(
          new InvalidRequestError({
            message: "No directory provided. Open a project in the frontend first.",
            kind: "configuration",
          }),
        )
      }

      const directory = ctx.payload.directory

      const current = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(eq(PublishDeploymentTable.project_id, context.project.id))
        .pipe(Database.first)

      // New apps and existing platform apps go to Workers for Platforms; legacy rows fall through.
      if (current?.runtime === "platform") {
        yield* requireOwner(current.cf_project_name, current.project_id)
        const result = yield* PlatformBuild.deployToPlatform(directory, current.cf_project_name).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
        yield* markLive(current.id, result)
        return { id: current.id, url: result.url, name: current.name, status: "live", runtime: "platform" }
      }

      if (!current) {
        const projectID = context.project.id
        const name = yield* PlatformName.choose(context.project.name ?? path.basename(directory), (candidate) =>
          CloudflarePlatform.scriptExists(candidate).pipe(
            Effect.flatMap((exists) => (exists ? Effect.succeed(true) : CloudflarePlatform.hostnameHasRecord(candidate))),
          ),
        ).pipe(Effect.catch((err) => Effect.fail(cfError(err))))

        // Claim the name with a tagged placeholder before the (slow) build so no one else can take it.
        const release = CloudflarePlatform.deleteScript(name).pipe(Effect.ignore)
        yield* CloudflarePlatform.claimScript(name, projectID).pipe(
          Effect.onError(() => release),
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
        // Tag reads are eventually consistent, so poll briefly. Another project's tag wins (last write) and we back off
        // without deleting its script; a still-missing tag is treated as ours since we just wrote it.
        const outcome = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) yield* Effect.sleep("400 millis")
            const owner = yield* CloudflarePlatform.scriptOwner(name)
            const result = PlatformName.claimOutcome(owner, projectID)
            if (result !== "unknown") return result
          }
          return "unknown" as const
        }).pipe(Effect.catch((err) => Effect.fail(cfError(err))))
        if (outcome === "taken")
          return yield* new InvalidRequestError({
            message: "That app name was just taken. Please try again.",
            kind: "cloudflare",
          })

        const id = `pub_${randomUUID().replace(/-/g, "").slice(0, 24)}`
        yield* database.db
          .insert(PublishDeploymentTable)
          .values({
            id,
            project_id: projectID,
            name,
            label: name,
            url: `https://${name}.${CloudflarePlatform.PLATFORM.zone}`,
            cf_project_name: name,
            status: "deploying",
            runtime: "platform",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .execute()
          .pipe(saveError, Effect.onError(() => release))

        const result = yield* PlatformBuild.deployToPlatform(directory, name).pipe(
          Effect.catch((err) =>
            database.db
              .delete(PublishDeploymentTable)
              .where(eq(PublishDeploymentTable.id, id))
              .execute()
              .pipe(Effect.ignore, Effect.andThen(release), Effect.andThen(Effect.fail(cfError(err)))),
          ),
        )
        yield* markLive(id, result)
        return { id, url: result.url, name, status: "live", runtime: "platform" }
      }

      const resolved = yield* Effect.tryPromise({
        try: () => resolveDeployDirectory(directory),
        catch: (e: unknown) =>
          new InvalidRequestError({
            message: String((e as Error)?.message ?? e),
            kind: "configuration",
          }),
      })

      const existing = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(eq(PublishDeploymentTable.project_id, context.project.id))
        .pipe(Database.first)

      const id = existing?.id || `pub_${randomUUID().replace(/-/g, "").slice(0, 24)}`
      const isUpdate = !!existing
      const cfProjectName = isUpdate ? existing.cf_project_name : `omai-${randomUUID().replace(/-/g, "").slice(0, 12)}`

      let url: string
      let deploymentId: string

      if (resolved.runtime) {
        const workersResult = yield* deployToWorkers(directory, cfProjectName).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
        url = workersResult.url
        deploymentId = workersResult.id
      } else {
        const files = yield* collectProjectFiles(resolved.directory)
        if (files.size === 0) {
          return yield* Effect.fail(
            new InvalidRequestError({
              message: "No files to deploy. Make sure your project has files.",
              kind: "configuration",
            }),
          )
        }

        const cfProject = yield* createOrUpdateProject(cfProjectName).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
        const actualName = cfProject.name
        url = `https://${actualName}.pages.dev`

        const deployment = yield* createDeployment(actualName, files).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
        deploymentId = deployment.id
      }

      const runtime: "pages" | "workers" = resolved.runtime ? "workers" : "pages"

      yield* (
        isUpdate
          ? database.db
              .update(PublishDeploymentTable)
              .set({
                url,
                runtime,
                cf_deployment_id: deploymentId,
                status: "live",
                time_updated: Date.now(),
              })
              .where(eq(PublishDeploymentTable.id, id))
              .execute()
          : database.db
              .insert(PublishDeploymentTable)
              .values({
                id,
                project_id: context.project.id,
                name: cfProjectName,
                label: cfProjectName,
                url,
                cf_project_name: cfProjectName,
                cf_deployment_id: deploymentId,
                status: "live",
                runtime,
                time_created: Date.now(),
                time_updated: Date.now(),
              })
              .execute()
      ).pipe(
        Effect.mapError(
          (error) =>
            new InvalidRequestError({
              message: `Failed to save deployment: ${error.message}`,
              kind: "configuration",
            }),
        ),
      )

      return { id, url, name: cfProjectName, status: "live", runtime }
    })

    const list = Effect.fn("PublishHttpApi.list")(function* () {
      const context = yield* InstanceState.context
      const rows = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(eq(PublishDeploymentTable.project_id, context.project.id))

      const latest = rows.sort((a, b) => b.time_created - a.time_created)[0]
      return latest
        ? [
            {
              id: latest.id,
              name: latest.name,
              label: latest.label,
              url: latest.url,
              status: latest.status,
              runtime: latest.runtime ?? undefined,
              created_at: latest.time_created,
            },
          ]
        : []
    })

    const redeploy = Effect.fn("PublishHttpApi.redeploy")(function* (ctx: {
      payload: { id: string; directory?: string; name?: string; runtime?: "pages" | "workers" }
    }) {
      yield* requirePublishEnv()
      const context = yield* InstanceState.context
      let row = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(eq(PublishDeploymentTable.id, ctx.payload.id))
        .pipe(Database.first)

      if (!row) {
        const projectRows = yield* database.db
          .select()
          .from(PublishDeploymentTable)
          .where(eq(PublishDeploymentTable.project_id, context.project.id))
        row = projectRows.sort((a, b) => b.time_created - a.time_created)[0]
      }

      const isNew = !row
      if (!row) {
        if (!ctx.payload.name) return yield* notFound("Deployment not found")
        row = {
          id: ctx.payload.id,
          project_id: context.project.id,
          name: ctx.payload.name,
          label: ctx.payload.name,
          url: "",
          cf_project_name: ctx.payload.name,
          cf_deployment_id: "",
          status: "live",
          runtime: ctx.payload.runtime === "workers" ? "workers" : "pages",
          custom_domain: null,
          custom_domain_status: null,
          time_created: Date.now(),
          time_updated: Date.now(),
        }
      }

      const directory = ctx.payload.directory || context.directory
      const isWorkers =
        row.runtime !== "platform" &&
        (row.runtime === "workers" || (!row.url.endsWith(".pages.dev") && row.runtime !== "pages"))

      let url: string
      let deploymentId: string
      let runtime: "pages" | "workers" | "platform"

      if (row.runtime === "platform") {
        yield* requireOwner(row.cf_project_name, row.project_id)
        const result = yield* PlatformBuild.deployToPlatform(directory, row.cf_project_name).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
        url = result.url
        deploymentId = result.id
        runtime = "platform"
      } else if (isWorkers) {
        const result = yield* deployToWorkers(directory, row.cf_project_name).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
        url = result.url
        deploymentId = result.id
        runtime = "workers"
      } else {
        const resolved = yield* Effect.tryPromise({
          try: () => resolveDeployDirectory(directory),
          catch: (e: unknown) =>
            new InvalidRequestError({
              message: String((e as Error)?.message ?? e),
              kind: "configuration",
            }),
        })

        const files = yield* collectProjectFiles(resolved.directory)
        if (files.size === 0) {
          return yield* Effect.fail(new InvalidRequestError({ message: "No files to deploy", kind: "configuration" }))
        }

        const deployment = yield* createDeployment(row.cf_project_name, files).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
        url = row.url || `https://${row.cf_project_name}.pages.dev`
        deploymentId = deployment.id
        runtime = "pages"
      }

      yield* (
        isNew
          ? database.db
              .insert(PublishDeploymentTable)
              .values({
                id: ctx.payload.id,
                project_id: context.project.id,
                name: row.name,
                label: row.label,
                url,
                cf_project_name: row.cf_project_name,
                cf_deployment_id: deploymentId,
                status: "live",
                runtime,
                time_created: Date.now(),
                time_updated: Date.now(),
              })
              .execute()
          : database.db
              .update(PublishDeploymentTable)
              .set({
                url,
                runtime,
                cf_deployment_id: deploymentId,
                status: "live",
                time_updated: Date.now(),
              })
              .where(eq(PublishDeploymentTable.id, row.id))
              .execute()
      ).pipe(
        Effect.mapError(
          (error) =>
            new InvalidRequestError({
              message: `Failed to save deployment: ${error.message}`,
              kind: "configuration",
            }),
        ),
      )

      return { id: row.id, url, name: row.name, status: "live", runtime }
    })

    const deleteDeployment = Effect.fn("PublishHttpApi.delete")(function* (ctx: { payload: { id: string } }) {
      const row = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(eq(PublishDeploymentTable.id, ctx.payload.id))
        .pipe(Database.first)

      if (!row) return yield* notFound("Deployment not found")

      if (row.runtime === "platform") {
        yield* requireOwner(row.cf_project_name, row.project_id)
        if (row.custom_domain) yield* removePlatformDomain(row.custom_domain)
        yield* CloudflarePlatform.deleteScript(row.cf_project_name).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
      } else if (row.runtime === "workers" || (!row.url.endsWith(".pages.dev") && row.runtime !== "pages")) {
        yield* deleteWorkerScript(row.cf_project_name).pipe(Effect.ignore)
      } else {
        yield* deleteProject(row.cf_project_name).pipe(Effect.ignore)
      }

      yield* database.db.delete(PublishDeploymentTable).where(eq(PublishDeploymentTable.id, ctx.payload.id)).execute()

      return { success: true }
    })

    const addDomain = Effect.fn("PublishHttpApi.addDomain")(function* (ctx: {
      payload: { deployment_id: string; domain: string }
    }) {
      yield* requirePublishEnv()

      const row = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(eq(PublishDeploymentTable.id, ctx.payload.deployment_id))
        .pipe(Database.first)

      if (!row) return yield* notFound("Deployment not found")

      if (row.runtime === "platform") {
        const zone = CloudflarePlatform.PLATFORM.zone
        const domain = ctx.payload.domain.trim().toLowerCase()
        if (!PlatformName.isHostname(domain))
          return yield* new InvalidRequestError({
            message: "Enter a valid domain like app.example.com.",
            kind: "configuration",
          })
        if (domain === zone || domain.endsWith(`.${zone}`))
          return yield* new InvalidRequestError({
            message: `Custom domains must be outside ${zone}.`,
            kind: "configuration",
          })
        if (row.custom_domain)
          return yield* new InvalidRequestError({
            message: "Remove the current custom domain first.",
            kind: "configuration",
          })
        const taken = yield* database.db
          .select()
          .from(PublishDeploymentTable)
          .where(eq(PublishDeploymentTable.custom_domain, domain))
        if (taken.some((other) => other.id !== row.id))
          return yield* new InvalidRequestError({
            message: "This domain is already connected to another app.",
            kind: "configuration",
          })

        // The zone's `*/*` route already sends every custom hostname to the
        // dispatcher (Cloudflare rejects a route for a hostname outside the
        // zone), which finds the app through the KV entry written here.
        // Undo the custom hostname if the KV write fails.
        yield* Effect.gen(function* () {
          yield* CloudflarePlatform.ensureFallbackOrigin()
          const hostname = yield* CloudflarePlatform.addCustomHostname(domain)
          yield* CloudflarePlatform.putHostname(domain, row.cf_project_name).pipe(
            Effect.onError(() => CloudflarePlatform.deleteCustomHostname(hostname.id).pipe(Effect.ignore)),
          )
        }).pipe(Effect.catch((err) => Effect.fail(platformError(err))))

        yield* database.db
          .update(PublishDeploymentTable)
          .set({ custom_domain: domain, custom_domain_status: "pending", time_updated: Date.now() })
          .where(eq(PublishDeploymentTable.id, row.id))
          .execute()

        return { domain, status: "pending", cname_target: `${row.cf_project_name}.${zone}` }
      }

      const isWorkers = row.runtime === "workers" || (!row.url.endsWith(".pages.dev") && row.runtime !== "pages")

      if (isWorkers) {
        const domain = yield* addWorkerDomain(ctx.payload.domain, row.cf_project_name).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )

        yield* database.db
          .update(PublishDeploymentTable)
          .set({
            custom_domain: ctx.payload.domain,
            custom_domain_status: "pending",
            time_updated: Date.now(),
          })
          .where(eq(PublishDeploymentTable.id, ctx.payload.deployment_id))
          .execute()

        const zone = yield* getZoneByName(ctx.payload.domain).pipe(Effect.catch(() => Effect.succeed(null)))

        return {
          domain: ctx.payload.domain,
          status: "pending",
          cname_target: row.url.replace("https://", ""),
          nameservers: zone?.name_servers || [],
        }
      }

      const domain = yield* addCustomDomain(row.cf_project_name, ctx.payload.domain).pipe(
        Effect.catch((err) => Effect.fail(cfError(err))),
      )

      yield* database.db
        .update(PublishDeploymentTable)
        .set({
          custom_domain: ctx.payload.domain,
          custom_domain_status: domain.status,
          time_updated: Date.now(),
        })
        .where(eq(PublishDeploymentTable.id, ctx.payload.deployment_id))
        .execute()

      const cfProject = yield* createOrUpdateProject(row.cf_project_name).pipe(Effect.catch(() => Effect.succeed(null)))
      const cnameTarget = cfProject?.subdomain || `${row.cf_project_name}.pages.dev`

      return {
        domain: ctx.payload.domain,
        status: domain.status,
        cname_target: cnameTarget,
      }
    })

    const listDomains = Effect.fn("PublishHttpApi.listDomains")(function* () {
      const context = yield* InstanceState.context

      const rows = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(eq(PublishDeploymentTable.project_id, context.project.id))

      const latest = rows.sort((a, b) => b.time_created - a.time_created)[0]
      if (!latest || !latest.custom_domain) return []

      if (latest.runtime === "platform") {
        const state = yield* platformDomainState(latest, latest.custom_domain)
        if (state.status !== latest.custom_domain_status)
          yield* database.db
            .update(PublishDeploymentTable)
            .set({ custom_domain_status: state.status, time_updated: Date.now() })
            .where(eq(PublishDeploymentTable.id, latest.id))
            .execute()
        return [{ domain: latest.custom_domain, status: state.status, cname_target: state.target }]
      }

      const isWorkers =
        latest.runtime === "workers" || (!latest.url.endsWith(".pages.dev") && latest.runtime !== "pages")

      if (isWorkers) {
        const zone = yield* getZoneByName(latest.custom_domain).pipe(Effect.catch(() => Effect.succeed(null)))
        const status = latest.custom_domain_status || "pending"

        return [
          {
            domain: latest.custom_domain,
            status,
            cname_target: latest.url.replace("https://", ""),
            nameservers: zone?.name_servers || [],
          },
        ]
      }

      const liveDomain = yield* getCustomDomain(latest.cf_project_name, latest.custom_domain).pipe(
        Effect.catch(() => Effect.succeed(null)),
      )

      const status = liveDomain?.status || latest.custom_domain_status || "pending"

      if (liveDomain && liveDomain.status !== latest.custom_domain_status) {
        yield* database.db
          .update(PublishDeploymentTable)
          .set({ custom_domain_status: status, time_updated: Date.now() })
          .where(eq(PublishDeploymentTable.id, latest.id))
          .execute()
      }

      const cfProject = yield* createOrUpdateProject(latest.cf_project_name).pipe(
        Effect.catch(() => Effect.succeed(null)),
      )
      const cnameTarget = cfProject?.subdomain || `${latest.cf_project_name}.pages.dev`

      return [
        {
          domain: latest.custom_domain,
          status,
          cname_target: cnameTarget,
        },
      ]
    })

    const removeDomain = Effect.fn("PublishHttpApi.removeDomain")(function* (ctx: {
      payload: { deployment_id: string; domain: string }
    }) {
      const row = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(eq(PublishDeploymentTable.id, ctx.payload.deployment_id))
        .pipe(Database.first)

      if (!row) return yield* notFound("Deployment not found")

      const isWorkers = row.runtime === "workers" || (!row.url.endsWith(".pages.dev") && row.runtime !== "pages")

      if (row.runtime === "platform") {
        yield* removePlatformDomain(ctx.payload.domain.trim().toLowerCase())
      } else if (isWorkers) {
        const domains = yield* listWorkerDomains(row.cf_project_name).pipe(Effect.catch(() => Effect.succeed([])))
        const matched = domains.find((d) => d.hostname === ctx.payload.domain)
        if (matched) {
          yield* removeWorkerDomain(matched.id).pipe(Effect.catch((err) => Effect.fail(cfError(err))))
        }
      } else {
        yield* deleteCustomDomain(row.cf_project_name, ctx.payload.domain).pipe(
          Effect.catch((err) => Effect.fail(cfError(err))),
        )
      }

      yield* database.db
        .update(PublishDeploymentTable)
        .set({
          custom_domain: null,
          custom_domain_status: null,
          time_updated: Date.now(),
        })
        .where(eq(PublishDeploymentTable.id, ctx.payload.deployment_id))
        .execute()

      return { success: true }
    })

    const setupZoneHandler = Effect.fn("PublishHttpApi.setupZone")(function* (ctx: { payload: { domain: string } }) {
      yield* requirePublishEnv()

      const result = yield* setupZone(ctx.payload.domain).pipe(
        Effect.catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes("already exists") || msg.includes("That domain already exists")) {
            return Effect.fail(
              new InvalidRequestError({
                message: `This domain is already connected to another Cloudflare account. Please remove it from that account first, or use a different domain.`,
                kind: "cloudflare",
              }),
            )
          }
          return Effect.fail(new InvalidRequestError({ message: msg, kind: "cloudflare" }))
        }),
      )

      return {
        status: result.status,
        name: result.name,
        name_servers: result.name_servers,
        message: result.message,
      }
    })

    const verifyDomain = Effect.fn("PublishHttpApi.verifyDomain")(function* (ctx: { payload: { domain: string } }) {
      yield* requirePublishEnv()

      const rows = yield* database.db
        .select()
        .from(PublishDeploymentTable)
        .where(inArray(PublishDeploymentTable.custom_domain, [ctx.payload.domain, ctx.payload.domain.trim().toLowerCase()]))

      const latest = rows.sort((a, b) => b.time_created - a.time_created)[0]
      if (!latest) {
        return yield* Effect.fail(
          new InvalidRequestError({ message: "No deployment found for this domain", kind: "configuration" }),
        )
      }

      if (latest.runtime === "platform") {
        const domain = ctx.payload.domain.trim().toLowerCase()
        const state = yield* platformDomainState(latest, domain)
        const resolved = yield* Effect.promise(() =>
          dnsPromises.resolveCname(domain).catch(() => [] as string[]),
        )
        // An apex domain can't hold a CNAME, so an active hostname is accepted without one.
        const cnameOk =
          state.status !== "error" &&
          (state.status === "active" ||
            resolved.some((target) => target.toLowerCase().replace(/\.$/, "") === state.target))
        if (state.status !== latest.custom_domain_status)
          yield* database.db
            .update(PublishDeploymentTable)
            .set({ custom_domain_status: state.status, time_updated: Date.now() })
            .where(eq(PublishDeploymentTable.id, latest.id))
            .execute()
        return {
          domain,
          cname_ok: cnameOk,
          nameservers_ok: true,
          cname_target: state.target,
          expected_nameservers: [],
          status: state.status,
        }
      }

      const isWorkers =
        latest.runtime === "workers" || (!latest.url.endsWith(".pages.dev") && latest.runtime !== "pages")

      if (isWorkers) {
        const rootDomain = ctx.payload.domain.split(".").slice(-2).join(".")

        const zoneResult = yield* setupZone(ctx.payload.domain).pipe(Effect.catch(() => Effect.succeed(null)))
        const expectedNs = zoneResult?.name_servers || []

        const nameserversOk = yield* Effect.tryPromise({
          try: async () => {
            if (expectedNs.length === 0) return false
            try {
              const actualNs = await dnsPromises.resolveNs(rootDomain)
              const normalizedExpected = expectedNs.map((ns) => ns.toLowerCase().replace(/\.$/, ""))
              const normalizedActual = actualNs.map((ns) => ns.toLowerCase().replace(/\.$/, ""))
              return normalizedExpected.every((ns) => normalizedActual.includes(ns))
            } catch {
              return false
            }
          },
          catch: () => false,
        })

        let newStatus = latest.custom_domain_status
        if (nameserversOk) {
          newStatus = "active"
        } else {
          newStatus = "pending"
        }

        if (newStatus !== latest.custom_domain_status) {
          yield* database.db
            .update(PublishDeploymentTable)
            .set({ custom_domain_status: newStatus, time_updated: Date.now() })
            .where(eq(PublishDeploymentTable.id, latest.id))
            .execute()
        }

        return {
          domain: ctx.payload.domain,
          cname_ok: true,
          nameservers_ok: nameserversOk,
          cname_target: "",
          expected_nameservers: expectedNs,
          status: newStatus,
        }
      }

      const liveDomain = yield* getCustomDomain(latest.cf_project_name, ctx.payload.domain).pipe(
        Effect.catch(() => Effect.succeed(null)),
      )

      const cfProject = yield* createOrUpdateProject(latest.cf_project_name).pipe(
        Effect.catch(() => Effect.succeed(null)),
      )
      const cnameTarget = cfProject?.subdomain || `${latest.cf_project_name}.pages.dev`

      const cnameOk = liveDomain?.status === "active"
      const newStatus = liveDomain?.status || latest.custom_domain_status || "pending"

      if (newStatus !== latest.custom_domain_status) {
        yield* database.db
          .update(PublishDeploymentTable)
          .set({ custom_domain_status: newStatus, time_updated: Date.now() })
          .where(eq(PublishDeploymentTable.id, latest.id))
          .execute()
      }

      return {
        domain: ctx.payload.domain,
        cname_ok: cnameOk,
        nameservers_ok: true,
        cname_target: cnameTarget,
        expected_nameservers: [],
        status: newStatus,
      }
    })

    return handlers
      .handle("deploy", deploy)
      .handle("list", list)
      .handle("redeploy", redeploy)
      .handle("delete", deleteDeployment)
      .handle("addDomain", addDomain)
      .handle("listDomains", listDomains)
      .handle("removeDomain", removeDomain)
      .handle("setupZone", setupZoneHandler)
      .handle("verifyDomain", verifyDomain)
  }),
)
