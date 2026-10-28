import { createClient, NorthflankApiError, type NorthflankClient } from "./client.js"
import type { NorthflankConfig } from "./config.js"
import type { AdapterContext, BusyReport, WorkspaceAdapter, WorkspaceInfo, WorkspaceTarget } from "./types.js"
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

  const ensureService = async (info: WorkspaceInfo, variables: Record<string, string | undefined>) => {
    const existing = await resolve(info.id)
    if (existing) {
      await client().setRuntimeEnvironment(existing.id, variables)
      return { id: existing.id, created: false }
    }
    const image = /[:@][^/:@]*$/.test(config.image) ? config.image : `${config.image}:latest`
    const created = await client().createService<{ data: { id: string } }>({
      name: serviceName(info.id),
      description: "OpenCode project MicroVM",
      billing: { deploymentPlan: config.plan },
      // Start with no instances: attaching a volume to a running service
      // restarts it, so booting before the attach costs a whole extra boot.
      // create() scales to one once the volume is in place.
      deployment: { instances: 0, external: { imagePath: image }, docker: { configType: "default" } },
      ports: [{ name: "p01", internalPort: config.port, public: true, protocol: "HTTP" }],
      runtimeEnvironment: { ...variables },
    })
    ids.set(info.id, created.data.id)
    return { id: created.data.id, created: true }
  }

  const ensureVolume = async (info: WorkspaceInfo) => {
    const name = volumeName(info.id)
    const existing = (await client().listVolumes()).find((item) => item.name === name)
    if (existing) return existing.id
    const created = await client().createVolume<{ data: { id: string } }>({
      name,
      mounts: [{ containerMountPath: requireDirectory(info) }],
      spec: { accessMode: "ReadWriteOnce", storageSize: config.volumeSizeMB },
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

    async remove(info) {
      const service = await resolve(info.id)
      forget(info.id)
      if (service) await client().deleteService(service.id)
      const volume = (await client().listVolumes()).find((item) => item.name === volumeName(info.id))
      if (volume) await client().deleteVolume(volume.id)
    },

    async target(info): Promise<WorkspaceTarget> {
      const headers = authHeaders()
      return { type: "remote", url: await vmURL(info.id), ...(headers ? { headers } : {}) }
    },

    async start(info) {
      const service = await requireService(info.id)
      await client()
        .resumeService(service.id)
        .catch((error: unknown) => {
          if (error instanceof NorthflankApiError && (error.status === 400 || error.status === 409)) return
          throw error
        })
        .catch(gone(info.id))
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

    async busy(info): Promise<BusyReport> {
      try {
        const response = await fetch(`${await vmURL(info.id)}/experimental/workspace/busy`, {
          headers: authHeaders(),
          signal: AbortSignal.timeout(3000),
        })
        if (!response.ok) return { busy: false, reasons: [] }
        const report = (await response.json()) as Partial<BusyReport>
        return { busy: report.busy === true, reasons: report.reasons ?? [] }
      } catch {
        return { busy: false, reasons: ["unreachable"] }
      }
    },
  }
}
