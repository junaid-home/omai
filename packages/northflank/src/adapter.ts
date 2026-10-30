import path from "node:path"
import { createClient, NorthflankApiError, type NorthflankClient } from "./client.js"
import type { NorthflankConfig } from "./config.js"
import type {
  AdapterContext,
  BusyReport,
  HealthReport,
  WorkspaceAdapter,
  WorkspaceInfo,
  WorkspaceTarget,
} from "./types.js"
import { WorkspaceGoneError } from "./types.js"

const slug = (value: string, max: number) => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
  return cleaned.replace(/-+$/, "")
}

const serviceName = (workspaceID: string) => `vm-${slug(workspaceID, 51)}`
const volumeName = (workspaceID: string) => `vol-${slug(workspaceID, 35)}`

export function northflankAdapter(config: NorthflankConfig): WorkspaceAdapter {
  let api: NorthflankClient | undefined
  const client = () => (api ??= createClient(config))
  const ids = new Map<string, string>()
  // Every proxied request, sync reconnect and busy probe resolves the VM URL,
  // and the Northflank API rate limit is shared by the whole team. A public
  // port's DNS is fixed for the life of the service, so resolve it once and
  // drop it only when the service goes away.
  const urls = new Map<string, string>()

  const forget = (workspaceID: string) => {
    ids.delete(workspaceID)
    urls.delete(workspaceID)
  }

  const authHeaders = () =>
    config.vmPassword ? { Authorization: `Basic ${btoa(`${config.vmUsername}:${config.vmPassword}`)}` } : undefined

  const resolve = async (workspaceID: string) => {
    const cached = ids.get(workspaceID)
    if (cached) return { id: cached, name: serviceName(workspaceID) }
    const found = (await client().listServices()).find((item) => item.name === serviceName(workspaceID))
    if (found) ids.set(workspaceID, found.id)
    return found
  }

  const requireService = async (workspaceID: string) => {
    const found = await resolve(workspaceID)
    if (!found) throw new WorkspaceGoneError(workspaceID)
    return found
  }

  const vmURL = async (workspaceID: string) => {
    const cached = urls.get(workspaceID)
    if (cached) return cached
    const { id } = await requireService(workspaceID)
    const dns = (await client().getPorts(id)).find((port) => port.public && port.dns)?.dns
    if (!dns) throw new Error(`Northflank service has no public port: ${id}`)
    const url = `${config.scheme}://${dns}`
    urls.set(workspaceID, url)
    return url
  }

  // A cached service ID outlives a service deleted out-of-band; the API's 404
  // is the first sign, so turn it into the gone signal the control plane
  // reconciles on instead of a generic failure.
  const gone = (workspaceID: string) => (error: unknown) => {
    if (!(error instanceof NorthflankApiError) || error.status !== 404) throw error
    forget(workspaceID)
    throw new WorkspaceGoneError(workspaceID)
  }

  const requireDirectory = (info: WorkspaceInfo) => {
    if (!info.directory) throw new Error("Northflank workspace has no directory; configure() must run first")
    return info.directory
  }

  // Projects live under `<root>/workspace/...`. Mounting the volume at that
  // shared folder (not the project's own) lets a booted reserve VM be claimed
  // for any project: the project folder is then created inside the volume.
  const mountPath = (directory: string) => directory.match(/^(.*?\/workspace)\//)?.[1] ?? directory

  const ensureService = async (info: WorkspaceInfo, variables: Record<string, string | undefined>) => {
    const image = /[:@][^/:@]*$/.test(config.image) ? config.image : `${config.image}:latest`
    const existing = await resolve(info.id)
    if (existing) {
      await client().setRuntimeEnvironment(existing.id, variables)
      // A service keeps the image it was created with; re-provisioning is the
      // point where it moves onto the currently configured one.
      if ((await client().getImage(existing.id)) !== image) await client().setImage(existing.id, image)
      return { id: existing.id, created: false }
    }
    // Two control planes (or a retried job) can race to create the same VM:
    // the loser adopts the winner's service instead of failing the project.
    const service = await client()
      .createService<{ data: { id: string } }>({
        name: serviceName(info.id),
        description: describe(info),
        billing: { deploymentPlan: config.plan },
        // Start with no instances: attaching a volume to a running service
        // restarts it, so booting before the attach costs a whole extra boot.
        // create() scales to one once the volume is in place.
        deployment: { instances: 0, external: { imagePath: image }, docker: { configType: "default" } },
        ports: [{ name: "p01", internalPort: config.port, public: true, protocol: "HTTP" }],
        runtimeEnvironment: { ...variables },
      })
      .then((created) => ({ id: created.data.id, created: true }))
      .catch(async (error: unknown) => {
        if (!(error instanceof NorthflankApiError) || error.status !== 409) throw error
        forget(info.id)
        const raced = await resolve(info.id)
        if (!raced) throw error
        return { id: raced.id, created: false }
      })
    ids.set(info.id, service.id)
    return service
  }

  const ensureVolume = async (info: WorkspaceInfo) => {
    const name = volumeName(info.id)
    const existing = (await client().listVolumes()).find((item) => item.name === name)
    if (existing) return existing.id
    const created = await client()
      .createVolume<{ data: { id: string } }>({
        name,
        mounts: [{ containerMountPath: mountPath(requireDirectory(info)) }],
        spec: { accessMode: "ReadWriteOnce", storageSize: config.volumeSizeMB },
      })
      .catch(async (error: unknown) => {
        if (!(error instanceof NorthflankApiError) || error.status !== 409) throw error
        const raced = (await client().listVolumes()).find((item) => item.name === name)
        if (!raced) throw error
        return { data: { id: raced.id } }
      })
    return created.data.id
  }

  return {
    name: "Northflank",
    description: "Run the workspace in an isolated Northflank MicroVM",

    configure(info, context) {
      const directory = context?.instance?.directory
      if (!directory) throw new Error("Northflank adapter requires an instance context")
      return { ...info, directory }
    },

    async create(info, env) {
      const directory = requireDirectory(info)
      const projectName = directory.split("/").filter(Boolean).pop() ?? info.id
      const variables = {
        ...env,
        OPENCODE_SERVER_USERNAME: config.vmUsername,
        ...(config.vmPassword ? { OPENCODE_SERVER_PASSWORD: config.vmPassword } : {}),
        ...(config.vmGlobalConfig ? { OPENCODE_GLOBAL_CONFIG: config.vmGlobalConfig } : {}),
        OPENCODE_PROJECT_NAME: projectName,
      }
      const service = await ensureService(info, variables)
      const volumeID = await ensureVolume(info)
      await client().attachVolume(volumeID, service.id)
      // An existing service is either already scaled or left at zero by a
      // create that failed after provisioning; scaling a paused or running
      // service is rejected or a no-op, which is fine either way.
      await client()
        .scaleService(service.id, 1)
        .catch((error: unknown) => {
          if (!service.created && error instanceof NorthflankApiError && (error.status === 400 || error.status === 409))
            return
          throw error
        })
    },

    async remove(info, context) {
      const service = await resolve(info.id)
      forget(info.id)
      if (service) await client().deleteService(service.id)
      if (context?.keepVolume) return
      const volume = (await client().listVolumes()).find((item) => item.name === volumeName(info.id))
      if (volume) await client().deleteVolume(volume.id)
    },

    async relabel(info) {
      const service = await resolve(info.id)
      if (service) await client().setDescription(service.id, describe(info))
    },

    async target(info): Promise<WorkspaceTarget> {
      const headers = authHeaders()
      return { type: "remote", url: await vmURL(info.id), ...(headers ? { headers } : {}) }
    },

    async start(info) {
      const service = await requireService(info.id)
      const settled = (error: unknown) => {
        if (error instanceof NorthflankApiError && (error.status === 400 || error.status === 409)) return
        throw error
      }
      await client().resumeService(service.id).catch(settled).catch(gone(info.id))
      // A create interrupted between provisioning and scaling leaves a service
      // at zero instances that resume alone never boots.
      await client().scaleService(service.id, 1).catch(settled).catch(gone(info.id))
    },

    async stop(info) {
      const service = await requireService(info.id)
      await client()
        .pauseService(service.id)
        .catch((error: unknown) => {
          if (error instanceof NorthflankApiError && (error.status === 400 || error.status === 409)) return
          throw error
        })
        .catch(gone(info.id))
    },

    async health(info): Promise<HealthReport> {
      const service = await requireService(info.id)
      const [deployment, containers] = await Promise.all([
        client().getDeploymentStatus(service.id),
        client().listContainerStatuses(service.id),
      ]).catch(gone(info.id))
      if (deployment.status === "FAILED") return { state: "failed", reason: "Deployment failed" }
      const crashed = containers.find((status) => status === "TASK_FAILED")
      if (crashed) return { state: "failed", reason: `Container exited (${crashed})` }
      if (deployment.status === "COMPLETED" && containers.includes("TASK_RUNNING")) return { state: "running" }
      return { state: "pending" }
    },

    // Rejects when the VM cannot answer: a loaded VM that is slow to reply
    // may be mid-turn, so the caller must not read a failed probe as idle.
    async busy(info): Promise<BusyReport> {
      const response = await fetch(`${await vmURL(info.id)}/experimental/workspace/busy`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Busy probe failed with HTTP ${response.status}`)
      const report = (await response.json()) as Partial<BusyReport>
      return { busy: report.busy === true, reasons: report.reasons ?? [] }
    },
  }
}

// Northflank rejects a description over 200 characters or containing anything
// outside this set (no "@", "+", "|", non-ASCII, ...), failing the whole create.
const DESCRIPTION_MAX = 200
const DESCRIPTION_DISALLOWED = /[^a-zA-Z0-9.,?\s\\/'"()[\];`%^&*\-_:!]/g

/** Who and what the VM is for, so the Northflank dashboard is readable without the control plane. */
function describe(info: WorkspaceInfo) {
  const owner = readOwner(info.extra)
  // Northflank rejects ">" and "@" in descriptions, so "key: value" pairs and
  // an email written with "at".
  const parts = [
    owner ? `user: ${owner.username}` : undefined,
    info.directory ? `projectName: ${path.posix.basename(info.directory)}` : undefined,
    owner?.email ? `email: ${owner.email.replace("@", " at ")}` : undefined,
  ]
  const text = parts
    .filter((part) => part !== undefined)
    .map((part) => `${part};`)
    .join(" ")
    .replace(DESCRIPTION_DISALLOWED, "-")
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 3)}...`
}

function readOwner(extra: unknown): { username: string; email?: string } | undefined {
  if (!extra || typeof extra !== "object" || !("owner" in extra)) return undefined
  const owner = extra.owner
  if (!owner || typeof owner !== "object" || !("username" in owner) || typeof owner.username !== "string")
    return undefined
  const email = "email" in owner && typeof owner.email === "string" ? owner.email : undefined
  return { username: owner.username, email }
}
