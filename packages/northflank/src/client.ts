import type { NorthflankConfig } from "./config.js"

export class NorthflankApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "NorthflankApiError"
  }
}

export type ServiceSummary = { id: string; name: string }
export type VolumeSummary = { id: string; name: string }
export type ServicePort = { name: string; internalPort: number; public?: boolean; dns?: string }

const RATE_LIMIT_RETRIES = 3

/** Honors `Retry-After` (seconds) when present, else backs off 1s, 2s, 4s; capped at 10s. */
function retryDelay(header: string | null, attempt: number) {
  const seconds = header === null ? Number.NaN : Number(header)
  return Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt, 10_000)
}

type ErrorBody = { error?: { message?: string }; message?: string }

function errorMessage(text: string, status: number) {
  try {
    const body = JSON.parse(text) as ErrorBody
    return body.error?.message ?? body.message ?? `Northflank API error (${status})`
  } catch {
    return text.slice(0, 200) || `Northflank API error (${status})`
  }
}

export function createClient(config: NorthflankConfig) {
  const request = async <A>(method: string, path: string, body?: unknown, attempt = 0): Promise<A> => {
    if (!config.token) throw new NorthflankApiError(401, "NORTHFLANK_API_TOKEN is not set")
    const response = await fetch(`${config.apiBase}/projects/${config.project}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    // The rate limit is shared by the whole team, so a burst elsewhere (the
    // dashboard, CI, another control plane) can reject a call this process
    // barely made. A throttled request was never applied, so waiting it out
    // and retrying is safe for every method, and turns a transient limit
    // into latency instead of a failed proxy request.
    if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await Bun.sleep(retryDelay(response.headers.get("retry-after"), attempt))
      return request<A>(method, path, body, attempt + 1)
    }
    if (!response.ok) throw new NorthflankApiError(response.status, errorMessage(text, response.status))
    return (text ? JSON.parse(text) : undefined) as A
  }

  const tolerant =
    (...statuses: number[]) =>
    <A>(promise: Promise<A>): Promise<A | undefined> =>
      promise.catch((error) => {
        if (error instanceof NorthflankApiError && statuses.includes(error.status)) return undefined
        throw error
      })

  return {
    listServices: async () =>
      (await request<{ data: { services: ServiceSummary[] } }>("GET", "/services")).data.services,
    createService: <A>(payload: unknown) => request<A>("POST", "/services/deployment", payload),
    getService: <A>(id: string) => request<A>("GET", `/services/${id}`),
    setRuntimeEnvironment: (id: string, variables: Record<string, string | undefined>) =>
      request("POST", `/services/${id}/runtime-environment`, { variables }),
    // The /scale endpoint is deprecated in favor of patching the deployment.
    scaleService: (id: string, instances: number) =>
      request("PATCH", `/services/deployment/${id}`, { deployment: { instances } }),
    pauseService: (id: string) => request("POST", `/services/${id}/pause`, {}),
    resumeService: (id: string) => request("POST", `/services/${id}/resume`, {}),
    deleteService: (id: string) => tolerant(404)(request("DELETE", `/services/${id}`)),
    getPorts: async (id: string) =>
      (await request<{ data: { ports: ServicePort[] } }>("GET", `/services/${id}/ports`)).data.ports,
    listVolumes: async () => (await request<{ data: VolumeSummary[] }>("GET", "/volumes")).data,
    createVolume: <A>(payload: unknown) => request<A>("POST", "/volumes", payload),
    deleteVolume: (id: string) => tolerant(404)(request("DELETE", `/volumes/${id}`)),
    attachVolume: (volumeID: string, serviceID: string) =>
      tolerant(
        404,
        409,
      )(request("POST", `/volumes/${volumeID}/attach`, { nfObject: { id: serviceID, type: "service" } })),
  }
}

export type NorthflankClient = ReturnType<typeof createClient>
