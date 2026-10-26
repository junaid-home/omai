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
  const request = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
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
