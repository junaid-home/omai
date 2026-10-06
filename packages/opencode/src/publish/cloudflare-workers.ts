import { Effect } from "effect"
import { readFile } from "fs/promises"
import { exec } from "child_process"
import path from "path"
import { promises as dnsPromises } from "dns"

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"

function getAccountId() {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!id) return Effect.fail(new Error("Missing CLOUDFLARE_ACCOUNT_ID environment variable"))
  return Effect.succeed(id)
}

function getApiToken() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) return Effect.fail(new Error("Missing CLOUDFLARE_API_TOKEN environment variable"))
  return Effect.succeed(token)
}

async function cfApi<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Cloudflare API ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

interface WorkerDeployResult {
  id: string
  url: string
  name: string
}

async function installDependencies(directory: string): Promise<void> {
  const pkgPath = path.join(directory, "package.json")
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
  } catch {
    throw new Error("Cannot read package.json")
  }

  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  }

  const needsInstall = !deps["@opennextjs/cloudflare"] || !deps["wrangler"]
  if (!needsInstall) return

  await new Promise<void>((resolve, reject) => {
    const child = exec("npm install @opennextjs/cloudflare@latest wrangler@latest --save-dev", {
      cwd: directory,
    })
    let stderr = ""
    child.stdout?.on("data", (data: string) => process.stdout.write(data))
    child.stderr?.on("data", (data: string) => {
      process.stderr.write(data)
      stderr += data
    })
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to install dependencies (exit ${code}): ${stderr.slice(-500)}`))
      } else {
        resolve()
      }
    })
    child.on("error", reject)
  })
}

async function configExists(directory: string): Promise<boolean> {
  const configs = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]
  for (const config of configs) {
    try {
      await readFile(path.join(directory, config))
      return true
    } catch {}
  }
  return false
}

async function migrateConfig(directory: string): Promise<void> {
  if (await configExists(directory)) return

  await new Promise<void>((resolve, reject) => {
    const child = exec("npx opennextjs-cloudflare migrate", {
      cwd: directory,
    })
    let stderr = ""
    child.stdout?.on("data", (data: string) => process.stdout.write(data))
    child.stderr?.on("data", (data: string) => {
      process.stderr.write(data)
      stderr += data
    })
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`OpenNext migrate failed (exit ${code}): ${stderr.slice(-500)}`))
      } else {
        resolve()
      }
    })
    child.on("error", reject)
  })
}

async function patchWranglerConfig(directory: string, projectName: string): Promise<void> {
  const configs = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]
  for (const file of configs) {
    const configPath = path.join(directory, file)
    try {
      const content = await readFile(configPath, "utf-8")
      if (!content) continue

      let updated = content.replace(/"name"\s*:\s*"[^"]*"/, `"name": "${projectName}"`)

      updated = updated.replace(/"services"\s*:\s*\[[\s\S]*?\]\s*,?/, "")

      await Bun.write(configPath, updated)
      return
    } catch {}
  }
}

async function buildForWorkers(directory: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = exec("npx opennextjs-cloudflare build", {
      cwd: directory,
      env: { ...process.env, NODE_ENV: "production" },
    })
    let stderr = ""
    child.stdout?.on("data", (data: string) => process.stdout.write(data))
    child.stderr?.on("data", (data: string) => {
      process.stderr.write(data)
      stderr += data
    })
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Workers build failed (exit ${code}): ${stderr.slice(-500)}`))
      } else {
        resolve()
      }
    })
    child.on("error", reject)
  })
}

async function getWorkersSubdomain(accountId: string, token: string): Promise<string> {
  const res = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  })
  const text = await res.text()
  console.log("[workers subdomain]", res.status, text)
  if (!res.ok) return "workers.dev"
  try {
    const data = JSON.parse(text)
    return data?.result?.subdomain || "workers.dev"
  } catch {
    return "workers.dev"
  }
}

async function deployWithWrangler(
  directory: string,
  projectName: string,
): Promise<{ id: string; url: string; name: string }> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId) throw new Error("Missing CLOUDFLARE_ACCOUNT_ID")
  if (!token) throw new Error("Missing CLOUDFLARE_API_TOKEN")

  const subdomain = await getWorkersSubdomain(accountId, token)

  return new Promise((resolve, reject) => {
    const child = exec("npx wrangler deploy --name " + projectName, {
      cwd: directory,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
    })
    let stderr = ""
    child.stdout?.on("data", (data: string) => process.stdout.write(data))
    child.stderr?.on("data", (data: string) => {
      process.stderr.write(data)
      stderr += data
    })
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Wrangler deploy failed (exit ${code}): ${stderr.slice(-500)}`))
      } else {
        resolve({
          id: `wrangler-${Date.now()}`,
          url: `https://${projectName}.${subdomain}.workers.dev`,
          name: projectName,
        })
      }
    })
    child.on("error", reject)
  })
}

export interface WorkersDeployment {
  id: string
  url: string
  name: string
}

export function deployToWorkers(directory: string, projectName: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    yield* Effect.tryPromise({
      try: () => installDependencies(directory),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    yield* Effect.tryPromise({
      try: () => migrateConfig(directory),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    yield* Effect.tryPromise({
      try: () => patchWranglerConfig(directory, projectName),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    yield* Effect.tryPromise({
      try: () => buildForWorkers(directory),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    const result = yield* Effect.tryPromise({
      try: () => deployWithWrangler(directory, projectName),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    return result
  })
}

export function deleteWorkerScript(projectName: string) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    yield* Effect.tryPromise({
      try: () =>
        cfApi(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${projectName}`, token, {
          method: "DELETE",
        }),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })
  })
}

async function getZoneId(domain: string, token: string): Promise<string> {
  const parts = domain.split(".")
  const zoneName = parts.slice(-2).join(".")
  const res = await fetch(`${CLOUDFLARE_API_BASE}/zones?name=${zoneName}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  })
  if (!res.ok) throw new Error(`Failed to look up zone for ${domain}`)
  const data = (await res.json()) as { result?: { id?: string }[] }
  const zone = data.result?.[0]
  if (!zone?.id) throw new Error(`Zone not found for ${domain}. Add it in the Cloudflare dashboard first.`)
  return zone.id
}

export interface WorkerDomain {
  id: string
  hostname: string
  service: string
  zone_id: string
  zone_name: string
}

export function addWorkerDomain(hostname: string, workerName: string): Effect.Effect<WorkerDomain, Error> {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()
    const zoneId = yield* Effect.tryPromise({
      try: () => getZoneId(hostname, token),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    const result = yield* Effect.tryPromise({
      try: () =>
        cfApi<{ result: WorkerDomain }>(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/domains`, token, {
          method: "PUT",
          body: JSON.stringify({
            hostname,
            service: workerName,
            zone_id: zoneId,
          }),
        }),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    return result.result
  })
}

export function listWorkerDomains(workerName: string): Effect.Effect<WorkerDomain[], Error> {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    const result = yield* Effect.tryPromise({
      try: () =>
        cfApi<{ result: WorkerDomain[] }>(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/domains`, token),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    return result.result.filter((d) => d.service === workerName)
  })
}

export function removeWorkerDomain(domainId: string): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    const token = yield* getApiToken()

    yield* Effect.tryPromise({
      try: () =>
        cfApi(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/domains/${domainId}`, token, { method: "DELETE" }),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })
  })
}

export interface ZoneInfo {
  id: string
  name: string
  status: "initializing" | "pending" | "active" | "deleted" | "paused"
  name_servers: string[]
  original_name_servers: string[] | null
}

export function getZoneByName(domain: string): Effect.Effect<ZoneInfo | null, Error> {
  return Effect.gen(function* () {
    const token = yield* getApiToken()
    const rootDomain = domain.split(".").slice(-2).join(".")

    const result = yield* Effect.tryPromise({
      try: () => cfApi<{ result: ZoneInfo[] }>(`${CLOUDFLARE_API_BASE}/zones?name=${rootDomain}`, token),
      catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
    })

    return result.result[0] || null
  })
}

export interface ZoneSetupResult {
  status: "initializing" | "pending" | "active"
  name?: string
  name_servers?: string[]
  message?: string
}

async function createZone(rootDomain: string, token: string): Promise<ZoneInfo> {
  const res = await fetch(`${CLOUDFLARE_API_BASE}/zones`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: rootDomain,
      type: "full",
      jump_start: false,
    }),
  })
  const data = (await res.json()) as { success: boolean; result?: ZoneInfo; errors?: { message?: string }[] }
  if (!data.success || !data.result) {
    const errMsg = data.errors?.[0]?.message || "Failed to create zone"
    throw new Error(`Failed to add ${rootDomain} to Cloudflare: ${errMsg}`)
  }
  return data.result
}

export function setupZone(domain: string): Effect.Effect<ZoneSetupResult, Error> {
  return Effect.gen(function* () {
    const token = yield* getApiToken()
    const rootDomain = domain.split(".").slice(-2).join(".")

    const existing = yield* getZoneByName(domain)
    if (!existing) {
      yield* Effect.tryPromise({
        try: () => createZone(rootDomain, token),
        catch: (e: unknown) => new Error(String((e as Error)?.message ?? e)),
      })
    }

    const zone = yield* getZoneByName(domain).pipe(Effect.catch(() => Effect.succeed(null)))
    const zoneNs = zone?.name_servers || []

    const currentNs = yield* Effect.promise(() => dnsPromises.resolveNs(rootDomain).catch(() => [] as string[]))

    const normalizeNs = (ns: string[]) => ns.map((n) => n.toLowerCase().replace(/\.$/, "")).sort()
    const normalizedZone = normalizeNs(zoneNs)
    const normalizedCurrent = normalizeNs(currentNs)

    if (
      normalizedCurrent.length > 0 &&
      normalizedZone.length > 0 &&
      JSON.stringify(normalizedCurrent) !== JSON.stringify(normalizedZone)
    ) {
      return yield* Effect.fail(
        new Error(
          `This domain is already connected to another Cloudflare account. Please remove it from that account first, or use a different domain.`,
        ),
      )
    }

    if (existing) {
      const nameserversUnchanged =
        !existing.original_name_servers ||
        existing.original_name_servers.length === 0 ||
        JSON.stringify(existing.original_name_servers) === JSON.stringify(existing.name_servers)
      if (nameserversUnchanged) {
        return {
          status: "initializing",
          name: existing.name,
          name_servers: existing.name_servers,
        }
      }
      return {
        status: "active",
        name: existing.name,
        name_servers: existing.name_servers,
      }
    }

    return {
      status: "initializing",
      name: zone?.name || rootDomain,
      name_servers: zoneNs,
      message: `Domain ${rootDomain} has been added. Update your nameservers at your registrar.`,
    }
  })
}
