import { Effect } from "effect"
import { createBLAKE3 } from "hash-wasm"

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"

function getAccountId(): Effect.Effect<string, Error> {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!id) return Effect.die(new Error("CLOUDFLARE_ACCOUNT_ID environment variable is required"))
  return Effect.succeed(id)
}

function getApiToken(): Effect.Effect<string, Error> {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) return Effect.die(new Error("CLOUDFLARE_API_TOKEN environment variable is required"))
  return Effect.succeed(token)
}

async function hashContent(content: Buffer): Promise<string> {
  const hasher = await createBLAKE3()
  hasher.update(content)
  return hasher.digest("hex").slice(0, 32)
}

function cfApi<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  }).then(async (res) => {
    const body = await res.text()
    if (!res.ok) {
      throw new Error(`Cloudflare API ${res.status}: ${body}`)
    }
    return JSON.parse(body) as T
  })
}

export interface PagesProject {
  id: string
  name: string
  subdomain: string
  domains: string[]
  created_on: string
  modified_on: string
}

export interface PagesDeployment {
  id: string
  url: string
  environment: string
  created_on: string
  latest_stage: {
    name: string
    status: string
  }
}

export function createOrUpdateProject(projectName: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    const projectUrl = `${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}`

    const getProject = () =>
      Effect.tryPromise({
        try: () => cfApi<{ result: PagesProject }>(projectUrl, token),
        catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
      })

    const existing = yield* getProject().pipe(Effect.catch(() => Effect.succeed(null)))
    if (existing?.result) return existing.result

    const created = yield* Effect.tryPromise({
      try: () =>
        cfApi<{ result: PagesProject }>(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects`, token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: projectName,
            production_branch: "main",
          }),
        }),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    }).pipe(
      Effect.catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("8000002") || msg.includes("already exists")) {
          return getProject()
        }
        return Effect.fail(err)
      }),
    )

    if (created && "result" in created) return (created as { result: PagesProject }).result
    return created as unknown as PagesProject
  })
}

export function createDeployment(projectName: string, files: Map<string, Buffer>) {
  return Effect.gen(function* () {
    const result = yield* deployToProject(projectName, files).pipe(
      Effect.catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("8000007") || msg.includes("Project not found")) {
          return Effect.gen(function* () {
            yield* createOrUpdateProject(projectName)
            return yield* deployToProject(projectName, files)
          })
        }
        return Effect.fail(err)
      }),
    )
    return result
  })
}

function deployToProject(projectName: string, files: Map<string, Buffer>) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    const uploadTokenRes = yield* Effect.tryPromise({
      try: () =>
        cfApi<{ jwt?: string; result?: { jwt?: string } }>(
          `${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}/upload-token`,
          token,
        ),
      catch: (e: unknown) => {
        return new Error(String((e as Error)?.message ?? e))
      },
    })
    const jwt = uploadTokenRes.jwt || uploadTokenRes.result?.jwt
    if (!jwt) {
      return yield* Effect.die(new Error(`No JWT in upload-token response: ${JSON.stringify(uploadTokenRes)}`))
    }

    const fileHashes = yield* Effect.tryPromise({
      try: async () => {
        const map = new Map<string, string>()
        for (const [path, content] of files) {
          map.set(path, await hashContent(content))
        }
        return map
      },
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    const hashes = Array.from(fileHashes.values())

    const missingRes = yield* Effect.tryPromise({
      try: () =>
        cfApi<{ result: string[] }>(`${CLOUDFLARE_API_BASE}/pages/assets/check-missing`, jwt, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hashes }),
        }),
      catch: (e: unknown) => {
        return new Error(String((e as Error)?.message ?? e))
      },
    })
    const missingHashes = new Set(missingRes.result)

    const filesToUpload = Array.from(files.entries()).filter(([path]) => missingHashes.has(fileHashes.get(path)!))

    if (filesToUpload.length > 0) {
      const payload = filesToUpload.map(([key, content]) => ({
        key: fileHashes.get(key)!,
        value: content.toString("base64"),
        base64: true,
        metadata: { contentType: getContentType(key) },
      }))

      console.log(`[Publish] Uploading ${payload.length} files`)
      yield* Effect.tryPromise({
        try: () =>
          cfApi<unknown>(`${CLOUDFLARE_API_BASE}/pages/assets/upload`, jwt, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
      })
    }

    yield* Effect.tryPromise({
      try: () =>
        cfApi<unknown>(`${CLOUDFLARE_API_BASE}/pages/assets/upsert-hashes`, jwt, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hashes }),
        }),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    const manifest: Record<string, string> = {}
    for (const [path] of files) {
      manifest[`/${path}`] = fileHashes.get(path)!
    }

    const deployRes = yield* Effect.tryPromise({
      try: () => {
        const formData = new FormData()
        formData.append("manifest", JSON.stringify(manifest))
        formData.append("branch", "main")

        return fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}/deployments`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        }).then(async (res) => {
          const text = await res.text()
          if (!res.ok) throw new Error(`Cloudflare API ${res.status}: ${text}`)
          return JSON.parse(text) as { result: PagesDeployment }
        })
      },
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    return deployRes.result
  })
}

function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase()
  const types: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    txt: "text/plain",
    xml: "application/xml",
    pdf: "application/pdf",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
  }
  return types[ext || ""] || "application/octet-stream"
}

export function deleteProject(projectName: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    yield* Effect.tryPromise({
      try: () =>
        cfApi<unknown>(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}`, token, {
          method: "DELETE",
        }),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })
  })
}

export function getDeploymentStatus(projectName: string, deploymentId: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    return yield* Effect.tryPromise({
      try: () =>
        cfApi<{ result: PagesDeployment }>(
          `${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}/deployments/${deploymentId}`,
          token,
        ),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })
  })
}

export interface PagesDomain {
  id: string
  name: string
  status: "initializing" | "pending" | "active" | "deactivated" | "blocked" | "error"
  certificate_authority: string
  validation_data?: {
    method: string
    status: string
    txt_name?: string
    txt_value?: string
  }
  verification_data?: {
    status: string
    error_message?: string
  }
}

export function addCustomDomain(projectName: string, domainName: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    return yield* Effect.tryPromise({
      try: () =>
        cfApi<{ result: PagesDomain }>(
          `${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}/domains`,
          token,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: domainName }),
          },
        ),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    }).pipe(Effect.map((res) => res.result))
  })
}

export function getCustomDomain(projectName: string, domainName: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    return yield* Effect.tryPromise({
      try: () =>
        cfApi<{ result: PagesDomain }>(
          `${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}/domains/${domainName}`,
          token,
        ),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    }).pipe(Effect.map((res) => res.result))
  })
}

export function listCustomDomains(projectName: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    return yield* Effect.tryPromise({
      try: () =>
        cfApi<{ result: PagesDomain[] }>(
          `${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}/domains`,
          token,
        ),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    }).pipe(Effect.map((res) => res.result))
  })
}

export function deleteCustomDomain(projectName: string, domainName: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    yield* Effect.tryPromise({
      try: () =>
        cfApi<unknown>(
          `${CLOUDFLARE_API_BASE}/accounts/${accountId}/pages/projects/${projectName}/domains/${domainName}`,
          token,
          { method: "DELETE" },
        ),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })
  })
}
