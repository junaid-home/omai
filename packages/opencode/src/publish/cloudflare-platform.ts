export * as CloudflarePlatform from "./cloudflare-platform"

import { Effect, Schema } from "effect"

const API = "https://api.cloudflare.com/client/v4"
const SAAS_DISABLED_CODES = [1404, 1456]
const NOT_SET_UP = "Publishing platform not set up. Run: bun run script/publish-platform.ts"
const OWNER_TAG = "omai-project-"
const PLACEHOLDER = `export default { fetch: () => new Response("Deploying…", { status: 503 }) }`

export const PLATFORM = {
  zone: process.env.CLOUDFLARE_PLATFORM_ZONE || "omai.ch",
  namespace: process.env.CLOUDFLARE_DISPATCH_NAMESPACE || "omai-apps",
  dispatcher: "omai-dispatcher",
  kvTitle: "omai-hostnames",
} as const

export type CustomHostname = { id: string; hostname: string; status: string; ssl: { status: string } }

/** Error from a non-2xx Cloudflare response. `codes` is parsed from `errors[].code`. */
export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
    readonly body: string,
  ) {
    super(`Cloudflare API ${status}: ${body}`)
  }
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.Struct({ errors: Schema.Array(Schema.Struct({ code: Schema.Number })) }),
)
const decodeResult = Schema.decodeUnknownOption(Schema.Struct({ result: Schema.Unknown }))
const decodePage = Schema.decodeUnknownOption(
  Schema.Struct({ result: Schema.Array(Schema.Unknown), result_info: Schema.Struct({ total_pages: Schema.Number }) }),
)
const decodeTags = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeCustomHostname = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    hostname: Schema.String,
    status: Schema.String,
    ssl: Schema.Struct({ status: Schema.String }),
  }),
)
const decodeIdList = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ id: Schema.String })))
const decodeRoutes = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({ id: Schema.String, pattern: Schema.String, script: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
)
const decodeKvList = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
)

export function domainStatus(h: CustomHostname): "active" | "pending" | "error" {
  const bad = ["blocked", "moved", "deleted"]
  if (bad.includes(h.status) || bad.includes(h.ssl.status) || h.ssl.status.startsWith("validation_timed_out"))
    return "error"
  if (h.status === "active" && h.ssl.status === "active") return "active"
  return "pending"
}

export function isSaasDisabled(body: unknown) {
  return errorCodes(body).some((code) => SAAS_DISABLED_CODES.includes(code))
}

export function isSaasDisabledError(err: unknown) {
  return err instanceof CloudflareError && err.codes.some((code) => SAAS_DISABLED_CODES.includes(code))
}

function errorCodes(body: unknown) {
  const decoded = decodeErrorBody(body)
  if (decoded._tag === "None") return []
  return decoded.value.errors.map((e) => e.code)
}

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

/** Returns the parsed JSON body (undefined when not JSON). Throws CloudflareError on non-2xx. */
async function request(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    // FormData bodies need fetch to set the multipart boundary itself.
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  })
  const text = await res.text()
  const json = decodeJson(text)
  if (!res.ok) throw new CloudflareError(res.status, json._tag === "Some" ? errorCodes(json.value) : [], text)
  return json._tag === "Some" ? json.value : undefined
}

function body(path: string, init?: RequestInit) {
  return Effect.gen(function* () {
    const token = yield* getApiToken()
    return yield* Effect.tryPromise({
      try: () => request(path, token, init),
      catch: toError,
    })
  })
}

/** Returns the parsed `result` field (undefined when absent). */
export function call(path: string, init?: RequestInit) {
  return body(path, init).pipe(
    Effect.map((json) => {
      const envelope = decodeResult(json)
      return envelope._tag === "Some" ? envelope.value.result : undefined
    }),
  )
}

/** Fetches every page of a paginated list endpoint. Fails if any page has an unexpected shape. */
export function listAll(path: string) {
  return Effect.gen(function* () {
    const separator = path.includes("?") ? "&" : "?"
    const items: unknown[] = []
    for (let page = 1, pages = 1; page <= pages; page++) {
      const decoded = decodePage(yield* body(`${path}${separator}per_page=100&page=${page}`))
      if (decoded._tag === "None") return yield* Effect.fail(new Error(`Unexpected Cloudflare list response: ${path}`))
      items.push(...decoded.value.result)
      pages = decoded.value.result_info.total_pages
    }
    return items
  })
}

export function account(path: string, init?: RequestInit) {
  return Effect.gen(function* () {
    const accountId = yield* getAccountId()
    return yield* call(`/accounts/${accountId}${path}`, init)
  })
}

function toError(e: unknown) {
  return e instanceof Error ? e : new Error(String(e))
}

export function isStatus(e: unknown, status: number) {
  return e instanceof CloudflareError && e.status === status
}

const memo = new Map<string, Promise<unknown>>()

/** Memoizes the first success per key; failures are not cached. */
function memoize<T>(key: string, effect: Effect.Effect<T, Error>) {
  return Effect.tryPromise({
    try: () => {
      const cached = memo.get(key)
      if (cached) return cached as Promise<T>
      const next = Effect.runPromise(effect)
      memo.set(key, next)
      next.catch(() => memo.delete(key))
      return next
    },
    catch: toError,
  })
}

export function ensurePlatform() {
  return memoize(
    "platform",
    Effect.gen(function* () {
      const missing = (e: Error) => (isStatus(e, 404) ? new Error(NOT_SET_UP) : e)
      yield* account(`/workers/dispatch/namespaces/${PLATFORM.namespace}`).pipe(Effect.mapError(missing))
      yield* account(`/workers/scripts/${PLATFORM.dispatcher}`).pipe(Effect.mapError(missing))
    }),
  )
}

export function zoneId() {
  return memoize(
    `zone:${PLATFORM.zone}`,
    Effect.gen(function* () {
      const result = yield* call(`/zones?name=${encodeURIComponent(PLATFORM.zone)}`)
      const zones = decodeIdList(result)
      if (zones._tag === "None" || !zones.value[0])
        return yield* Effect.fail(new Error(`Zone not found: ${PLATFORM.zone}`))
      return zones.value[0].id
    }),
  )
}

export function kvNamespaceId() {
  return memoize(
    `kv:${PLATFORM.kvTitle}`,
    Effect.gen(function* () {
      const result = yield* account(`/storage/kv/namespaces?per_page=100`)
      const list = decodeKvList(result)
      const found = list._tag === "Some" ? list.value.find((n) => n.title === PLATFORM.kvTitle) : undefined
      if (!found) return yield* Effect.fail(new Error(NOT_SET_UP))
      return found.id
    }),
  )
}

const decodeScript = Schema.decodeUnknownOption(Schema.Struct({ script: Schema.Struct({}) }))

/** The script GET returns 200 with `script: null` for missing scripts, so a 2xx alone doesn't mean it exists. */
export function scriptPresent(result: unknown) {
  return decodeScript(result)._tag === "Some"
}

export function scriptExists(name: string) {
  return account(`/workers/dispatch/namespaces/${PLATFORM.namespace}/scripts/${name}`).pipe(
    Effect.map(scriptPresent),
    Effect.catch((e) => (isStatus(e, 404) ? Effect.succeed(false) : Effect.fail(e))),
  )
}

export function deleteScript(name: string) {
  return account(`/workers/dispatch/namespaces/${PLATFORM.namespace}/scripts/${name}`, { method: "DELETE" }).pipe(
    Effect.asVoid,
    Effect.catch((e) => (isStatus(e, 404) ? Effect.void : Effect.fail(e))),
  )
}

/** Uploads a 503 placeholder Worker tagged with the owning project so the name is reserved during the build. */
export function claimScript(name: string, projectID: string) {
  return Effect.gen(function* () {
    const form = new FormData()
    form.append(
      "metadata",
      new Blob([JSON.stringify({ main_module: "placeholder.mjs", compatibility_date: "2026-10-01" })], {
        type: "application/json",
      }),
    )
    form.append(
      "placeholder.mjs",
      new Blob([PLACEHOLDER], { type: "application/javascript+module" }),
      "placeholder.mjs",
    )
    const script = `/workers/dispatch/namespaces/${PLATFORM.namespace}/scripts/${name}`
    yield* account(script, { method: "PUT", body: form })
    yield* account(`${script}/tags`, { method: "PUT", body: JSON.stringify([`${OWNER_TAG}${projectID}`]) })
  })
}

/** Project ID from the script's owner tag; undefined when the script or tag is missing. */
export function scriptOwner(name: string) {
  return account(`/workers/dispatch/namespaces/${PLATFORM.namespace}/scripts/${name}/tags`).pipe(
    Effect.map((result) => {
      const tags = decodeTags(result)
      const owner = tags._tag === "Some" ? tags.value.find((tag) => tag.startsWith(OWNER_TAG)) : undefined
      return owner?.slice(OWNER_TAG.length)
    }),
    Effect.catch((e) => (isStatus(e, 404) ? Effect.succeed(undefined) : Effect.fail(e))),
  )
}

/** True when the zone has a DNS record for exactly `<name>.<zone>` (the wildcard record doesn't count). */
export function hostnameHasRecord(name: string) {
  return Effect.gen(function* () {
    const zone = yield* zoneId()
    const records = decodeIdList(
      yield* call(`/zones/${zone}/dns_records?name=${encodeURIComponent(`${name}.${PLATFORM.zone}`)}`),
    )
    return records._tag === "Some" && records.value.length > 0
  })
}

export function addCustomHostname(hostname: string) {
  return Effect.gen(function* () {
    const zone = yield* zoneId()
    const result = yield* call(`/zones/${zone}/custom_hostnames`, {
      method: "POST",
      body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } }),
    })
    return yield* requireHostname(result)
  })
}

export function getCustomHostname(hostname: string) {
  return Effect.gen(function* () {
    const zone = yield* zoneId()
    const result = yield* call(`/zones/${zone}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`)
    const first = Array.isArray(result) ? result[0] : undefined
    const decoded = decodeCustomHostname(first)
    return decoded._tag === "Some" ? decoded.value : undefined
  })
}

export function deleteCustomHostname(id: string) {
  return Effect.gen(function* () {
    const zone = yield* zoneId()
    yield* call(`/zones/${zone}/custom_hostnames/${id}`, { method: "DELETE" })
  })
}

export function ensureFallbackOrigin() {
  return Effect.gen(function* () {
    const zone = yield* zoneId()
    const origin = `fallback.${PLATFORM.zone}`
    const records = decodeIdList(yield* call(`/zones/${zone}/dns_records?name=${encodeURIComponent(origin)}`))
    if (records._tag === "None" || records.value.length === 0)
      yield* call(`/zones/${zone}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type: "AAAA", name: origin, content: "100::", proxied: true }),
      })
    yield* call(`/zones/${zone}/custom_hostnames/fallback_origin`, {
      method: "PUT",
      body: JSON.stringify({ origin }),
    })
  })
}

export function putHostname(hostname: string, script: string) {
  return Effect.gen(function* () {
    const kv = yield* kvNamespaceId()
    yield* account(`/storage/kv/namespaces/${kv}/values/${encodeURIComponent(hostname)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: script,
    })
  })
}

export function deleteHostname(hostname: string) {
  return Effect.gen(function* () {
    const kv = yield* kvNamespaceId()
    yield* account(`/storage/kv/namespaces/${kv}/values/${encodeURIComponent(hostname)}`, { method: "DELETE" }).pipe(
      Effect.catch((e) => (isStatus(e, 404) ? Effect.void : Effect.fail(e))),
    )
  })
}

/**
 * Omit `script` to create a bypass route that disables Workers for the pattern.
 * An existing route for the pattern is reused only when it targets the same script; it is never modified.
 */
export function addRoute(pattern: string, script?: string) {
  return Effect.gen(function* () {
    const zone = yield* zoneId()
    const existing = yield* findRoute(zone, pattern)
    if (existing && (existing.script || undefined) !== script)
      return yield* Effect.fail(
        new Error(
          `Route ${pattern} already exists pointing to ${existing.script ? `script ${existing.script}` : "no script (bypass)"}, ` +
            `expected ${script ? `script ${script}` : "no script (bypass)"}. Resolve it in the Cloudflare dashboard.`,
        ),
      )
    if (existing) return existing.id
    const created = decodeIdList([
      yield* call(`/zones/${zone}/workers/routes`, {
        method: "POST",
        body: JSON.stringify({ pattern, script }),
      }),
    ])
    if (created._tag === "None") return yield* Effect.fail(new Error("Unexpected Cloudflare response creating route"))
    return created.value[0].id
  })
}

export function deleteRouteByPattern(pattern: string) {
  return Effect.gen(function* () {
    const zone = yield* zoneId()
    const existing = yield* findRoute(zone, pattern)
    if (!existing) return
    yield* call(`/zones/${zone}/workers/routes/${existing.id}`, { method: "DELETE" })
  })
}

export function routeExists(pattern: string) {
  return Effect.gen(function* () {
    return (yield* findRoute(yield* zoneId(), pattern)) !== undefined
  })
}

function findRoute(zone: string, pattern: string) {
  return call(`/zones/${zone}/workers/routes`).pipe(
    Effect.map((result) => {
      const routes = decodeRoutes(result)
      return routes._tag === "Some" ? routes.value.find((r) => r.pattern === pattern) : undefined
    }),
  )
}

function requireHostname(result: unknown) {
  const decoded = decodeCustomHostname(result)
  if (decoded._tag === "None") return Effect.fail(new Error("Unexpected Cloudflare custom hostname response"))
  return Effect.succeed(decoded.value)
}
