import type { ServicePort } from "../src/client.js"

type Service = {
  id: string
  name: string
  payload: Record<string, unknown>
  paused: boolean
  instances?: number
  variables?: Record<string, string | undefined>
  deployment?: { status: string; reason?: string }
  containers?: string[]
}

type Volume = { id: string; name: string; payload: Record<string, unknown> }

export type RecordedRequest = { method: string; path: string; authorization?: string; body?: unknown }

/**
 * Real local HTTP server emulating the Northflank REST API surface the
 * adapter uses. Tests assert against recorded requests and server state —
 * no module mocks.
 */
export function northflankStub(input?: { dns?: string; token?: string; pageSize?: number; serviceLag?: number }) {
  const services = new Map<string, Service>()
  // The real API is eventually consistent: a service it just created answers
  // 404 to the next few calls naming it. `serviceLag` is how many.
  const unseen = new Map<string, number>()
  const seen = (id: string) => {
    const left = unseen.get(id) ?? 0
    if (left <= 0) return services.has(id)
    unseen.set(id, left - 1)
    return false
  }
  const volumes = new Map<string, Volume>()
  const requests: RecordedRequest[] = []
  const throttle = { remaining: 0 }

  const token = input?.token ?? "nf-test-token"
  const dns = input?.dns ?? "127.0.0.1:4096"
  const json = (data: unknown, status = 200) => Response.json(data, { status })
  const fail = (status: number, message: string) => json({ error: { message } }, status)
  // Cursor pagination as the real API serves it: a 24-character cursor and
  // `pagination.hasNextPage`. The default page is small so tests cross it.
  const page = <A>(url: URL, items: A[]) => {
    const size = Math.min(Number(url.searchParams.get("per_page") ?? input?.pageSize ?? 2), input?.pageSize ?? 2)
    const start = Number(url.searchParams.get("cursor") ?? 0)
    const next = start + size
    return {
      items: items.slice(start, next),
      pagination: {
        hasNextPage: next < items.length,
        count: items.slice(start, next).length,
        ...(next < items.length ? { cursor: String(next).padStart(24, "0") } : {}),
      },
    }
  }

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      const method = request.method
      const body = request.body ? await request.json().catch(() => undefined) : undefined
      requests.push({
        method,
        path,
        authorization: request.headers.get("authorization") ?? undefined,
        ...(body === undefined ? {} : { body }),
      })

      if (throttle.remaining > 0) {
        throttle.remaining -= 1
        return Response.json(
          { error: { status: 429, message: "API rate limit exceeded for this team." } },
          { status: 429, headers: { "Retry-After": "0" } },
        )
      }

      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return fail(401, "The token used to authenticate does not have permission to access this endpoint.")

      // /v1/projects/{project}/{kind}/{id}/{action}
      const segments = path.split("/").filter(Boolean)
      if (segments[0] !== "v1" || segments[1] !== "projects") return fail(404, "Not found")
      const [kind, id, action] = segments.slice(3)
      const payload = body as Record<string, unknown> | undefined

      if (kind === "services" && id === "deployment" && method === "POST") {
        const name = payload?.["name"] as string | undefined
        const plan = (payload?.["billing"] as { deploymentPlan?: string } | undefined)?.deploymentPlan
        if (!name || !plan) return fail(400, "Request failed payload validation - see details.")
        // The real API's description rule (max 200, restricted characters).
        const description = payload?.["description"]
        if (
          typeof description === "string" &&
          (description.length > 200 || !/^[a-zA-Z0-9.,?\s\\/'"()[\];`%^&*\-_:!]+$/.test(description))
        )
          return fail(400, "Request failed payload validation - see details.")
        const serviceID = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
        if (services.has(serviceID)) return fail(409, `Service '${name}' already exists`)
        services.set(serviceID, { id: serviceID, name, payload: payload ?? {}, paused: false })
        unseen.set(serviceID, input?.serviceLag ?? 0)
        return json({ data: { id: serviceID, name } })
      }

      if (kind === "services" && id && !action) {
        const service = services.get(id)
        if (!service) return fail(404, `Could not find service '${id}'`)
        if (method === "GET")
          return json({
            data: {
              ...service.payload,
              id: service.id,
              name: service.name,
              deployment: { instances: service.instances ?? 0 },
              status: { deployment: service.deployment ?? { status: "COMPLETED", reason: "DEPLOYING" } },
            },
          })
        if (method === "DELETE") {
          services.delete(id)
          return json({ data: {} })
        }
      }

      if (kind === "services" && id && action === "runtime-environment" && method === "POST") {
        const service = services.get(id)
        if (!service) return fail(404, `Could not find service '${id}'`)
        // The real API's field; anything else is a 400.
        const runtime = payload?.["runtimeEnvironment"]
        if (!runtime || typeof runtime !== "object") return fail(400, "Request failed payload validation - see details.")
        service.variables = runtime as Record<string, string | undefined>
        return json({ data: {} })
      }

      if (kind === "services" && id && action === "containers" && method === "GET") {
        const service = services.get(id)
        if (!service) return fail(404, `Could not find service '${id}'`)
        const containers = (service.containers ?? ["TASK_RUNNING"]).map((status, index) => ({
          name: `${service.id}-${index}`,
          status,
          createdAt: 1,
          updatedAt: 1,
        }))
        return json({ data: { containers }, pagination: { hasNextPage: false, count: containers.length } })
      }

      if (kind === "services" && id && action === "ports") {
        if (!services.has(id)) return fail(404, `Could not find service '${id}'`)
        const ports: ServicePort[] = [{ name: "p01", internalPort: 4096, public: true, dns }]
        return json({ data: { ports } })
      }

      if (kind === "services" && id === "deployment" && action && method === "PATCH") {
        const service = services.get(action)
        if (!service || !seen(action)) return fail(404, `Could not find service '${action}'`)
        const deployment = payload?.["deployment"] as
          | { instances?: number; external?: { imagePath?: string } }
          | undefined
        if (typeof payload?.["description"] === "string") service.payload["description"] = payload["description"]
        if (deployment?.instances !== undefined) service.instances = deployment.instances
        if (deployment?.external?.imagePath) {
          const current = (service.payload["deployment"] ?? {}) as Record<string, unknown>
          service.payload["deployment"] = { ...current, external: deployment.external }
        }
        return json({ data: {} })
      }

      if (kind === "services" && id && (action === "pause" || action === "resume")) {
        const service = services.get(id)
        if (!service) return fail(404, `Could not find service '${id}'`)
        if (action === "resume" && !service.paused) return fail(400, "Could not resume as service is not paused")
        service.paused = action === "pause"
        return json({ data: {} })
      }

      if (kind === "services" && id === undefined && method === "GET") {
        const result = page(url, [...services.values()])
        return json({ data: { services: result.items }, pagination: result.pagination })
      }

      if (kind === "volumes" && id === undefined && method === "GET") {
        const result = page(url, [...volumes.values()])
        return json({ data: result.items, pagination: result.pagination })
      }

      if (kind === "volumes" && id === undefined && method === "POST") {
        const name = payload?.["name"] as string | undefined
        if (!name) return fail(400, "Request failed payload validation - see details.")
        const volumeID = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
        volumes.set(volumeID, { id: volumeID, name, payload: payload ?? {} })
        return json({ data: { id: volumeID, name } })
      }

      if (kind === "volumes" && id && action === "attach") {
        if (!volumes.has(id)) return fail(404, `Could not find volume '${id}'`)
        const target = (payload?.["nfObject"] as { id?: string } | undefined)?.id
        if (!target || !seen(target)) return fail(404, `Could not find service '${target}'`)
        return json({ data: {} })
      }

      if (kind === "volumes" && id && !action && method === "DELETE") {
        volumes.delete(id)
        return json({ data: {} })
      }

      return fail(404, `No stub route: ${method} ${path}`)
    },
  })

  return {
    apiBase: `http://127.0.0.1:${server.port}/v1`,
    token,
    services,
    volumes,
    requests,
    /** Rejects the next `count` requests with a 429, as the shared team limit does. */
    throttle: (count: number) => {
      throttle.remaining = count
    },
    stop: () => server.stop(true),
  }
}

/** Stand-in for the OpenCode server running inside the MicroVM. */
export function vmStub() {
  const report = { busy: false, reasons: [] as string[] }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/experimental/workspace/busy") return Response.json(report)
      return new Response(null, { status: 404 })
    },
  })
  return {
    host: `127.0.0.1:${server.port}`,
    setBusy(busy: boolean, reasons: string[] = []) {
      report.busy = busy
      report.reasons = reasons
    },
    crash: () => server.stop(true),
    stop: () => server.stop(true),
  }
}
