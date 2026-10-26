import { Authentication } from "@opencode-ai/core/authentication"
import { PreviewCapability } from "@opencode-ai/core/preview-capability"
import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Effect, FileSystem, Option, Schedule, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"
import mime from "mime-types"
import { previewProxyResponse, previewProxyTarget, proxyBase, rewritePreviewHtml } from "@/server/preview-proxy"
import { StaticPreview } from "./static"
import { previewDirectoryForPort } from "./server"
import { visualBridgeScript } from "./visual-bridge"

export function config() {
  if (!Authentication.central()) return undefined
  const value = process.env.OPENCODE_PREVIEW_URL
  if (!value) {
    if (process.env.OPENCODE_WORKSPACE_ID) return undefined
    throw new Error("Central mode requires a dedicated OPENCODE_PREVIEW_URL")
  }
  const url = new URL(value)
  const main = new URL(Authentication.publicOrigin()!)
  if (
    url.protocol !== "https:" ||
    url.hostname === main.hostname ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("OPENCODE_PREVIEW_URL must use a distinct hostname and HTTPS")
  }
  const port = Number(process.env.OPENCODE_PREVIEW_PORT ?? "4097")
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid OPENCODE_PREVIEW_PORT")
  const publicPreview = process.env.OPENCODE_PREVIEW_PUBLIC === "1"
  return { origin: url.origin, port, public: publicPreview }
}

function cookie(request: HttpServerRequest.HttpServerRequest, name: string) {
  const values = (request.headers.cookie ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`))
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined
}

// SameSite=None is required, not lax. The app embeds previews in a cross-site
// iframe (app origin vs. the dedicated OPENCODE_PREVIEW_URL origin), so a Lax
// cookie is never sent on the redirect that follows ticket exchange and every
// embed 401s. This widens the cookie to third-party embedders only; it grants
// nothing beyond this one preview, because the name is port- or snapshot-scoped,
// Path pins it to that preview, it is HttpOnly, and validate() re-checks the
// session, port, and origin on every request. The app session cookie stays Lax
// and host-only, so untrusted preview content still cannot reach app auth.
function setCookie(name: string, value: string, scope: string, expiresAt: number) {
  return `${name}=${value}; Path=${scope}; HttpOnly; Secure; SameSite=None; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`
}

function staticResponse(file: string, asset: string, bridge: string) {
  return Effect.gen(function* () {
    const workspace = path.dirname(path.dirname(path.dirname(file)))
    const target = asset
      ? yield* Effect.tryPromise(() => CentralStorage.resolveUnder(workspace, path.resolve(workspace, asset)))
      : file
    const canonical = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(target))
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise(() => open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)),
      (value) => Effect.promise(() => value.close().catch(() => {})),
    )
    const info = yield* Effect.tryPromise(() => handle.stat())
    if (!info.isFile()) return HttpServerResponse.empty({ status: 404 })
    if (!asset || path.extname(canonical).toLowerCase() === ".html") {
      if (info.size > 8 * 1024 * 1024) return HttpServerResponse.empty({ status: 413 })
      const html = yield* Effect.tryPromise(() => handle.readFile("utf8"))
      return HttpServerResponse.text(
        injectBridge(rewritePreviewHtml(html, `/static/${path.basename(file, ".html")}/`), bridge),
        { contentType: "text/html" },
      )
    }
    return HttpServerResponse.stream(
      Stream.fromAsyncIterable(handle.createReadStream({ autoClose: false }), (cause) => cause),
      { contentType: mime.lookup(canonical) || "application/octet-stream" },
    )
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
}

export function injectBridge(html: string, bridge: string) {
  const script = `<script id="omai-visual-bridge" data-omai-visual-bridge>${bridge.replace(/<\/script/gi, "<\\/script")}</script>`
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}</body>`) : `${html}${script}`
}

/** Dedicated listener routes. This layer never mounts the application API or its auth cookies. */
export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const selected = config()
    if (!selected) return
    const parent = Authentication.publicOrigin()!
    const capabilities = yield* PreviewCapability.Service
    const client = yield* HttpClient.HttpClient
    const bridge = visualBridgeScript(parent)
    yield* capabilities.prune().pipe(
      Effect.catch(() => Effect.logWarning("Preview capability cleanup failed")),
      Effect.repeat(Schedule.spaced("1 hour")),
      Effect.forkScoped,
    )
    yield* router.add("*", "/*", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, selected.origin)
        // Reverse proxies preserve the public Host. A different host is never an API fallback.
        if (request.headers.host !== new URL(selected.origin).host) return HttpServerResponse.empty({ status: 404 })
        const staticID = /^\/static\/([a-f0-9-]{36})\/(.*)$/.exec(url.pathname)
        const target = previewProxyTarget(url)
        if (!target && !staticID) return HttpServerResponse.empty({ status: 404 })
        const port = target?.port ?? 0
        const base = staticID ? `/static/${staticID[1]}/` : proxyBase(port)
        const name = staticID ? `omai_preview_static_${staticID[1]}` : `omai_preview_${port}`
        const origin = request.headers.origin
        if (origin && origin !== selected.origin && origin !== parent) return HttpServerResponse.empty({ status: 403 })
        if (request.method === "OPTIONS") return HttpServerResponse.empty({ status: 204 })
        const serve = (directory: string, refreshCookie?: string) =>
          Effect.gen(function* () {
            const storage = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(directory)).pipe(
              Effect.option,
            )
            if (Option.isNone(storage)) return HttpServerResponse.empty({ status: 503 })
            const response = target
              ? yield* previewProxyResponse(client, request, target, bridge)
              : yield* staticResponse(directory, decodeURIComponent(staticID![2]), bridge)
            const headers: Record<string, string> = {
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              "Content-Security-Policy": `frame-ancestors ${parent}`,
              "X-Content-Type-Options": "nosniff",
              "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
            }
            if (refreshCookie) headers["Set-Cookie"] = refreshCookie
            return HttpServerResponse.setHeaders(response, headers)
          })
        if (selected.public) {
          const directory = staticID ? StaticPreview.snapshotFile(staticID[1]) : previewDirectoryForPort(port)
          if (!directory) return HttpServerResponse.empty({ status: 404 })
          return yield* serve(directory)
        }
        const tickets = url.searchParams.getAll("ticket")
        if (tickets.length) {
          if (request.method !== "GET" || tickets.length !== 1) return HttpServerResponse.empty({ status: 400 })
          const grant = yield* capabilities.exchange(tickets[0], port, selected.origin)
          if (!grant) return HttpServerResponse.empty({ status: 401 })
          if (staticID && path.basename(grant.directory) !== `${staticID[1]}.html`)
            return HttpServerResponse.empty({ status: 403 })
          url.searchParams.delete("ticket")
          return HttpServerResponse.empty({
            status: 303,
            headers: {
              Location: `${url.pathname}${url.search}`,
              "Set-Cookie": setCookie(name, grant.cookie, base, grant.expiresAt),
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
            },
          })
        }
        const token = cookie(request, name)
        const grant = token ? yield* capabilities.validate(token, port, selected.origin) : undefined
        if (!grant) return HttpServerResponse.empty({ status: 401 })
        if (staticID && path.basename(grant.directory) !== `${staticID[1]}.html`)
          return HttpServerResponse.empty({ status: 403 })
        if (target && previewDirectoryForPort(port) !== grant.directory)
          return HttpServerResponse.empty({ status: 404 })
        return yield* serve(grant.directory, setCookie(name, token!, base, grant.expiresAt))
      }).pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(16 * 1024 * 1024)),
        Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
      ),
    )
  }),
)

export * as PreviewHttp from "./http"
