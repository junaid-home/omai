import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { requestBody } from "@/server/routes/instance/httpapi/middleware/proxy"
import { ProxyUtil } from "@/server/proxy-util"

const PREVIEW_PROXY_PREFIX = "/global/preview/proxy/"

export function previewProxyTarget(url: URL): { port: number; path: string } | undefined {
  if (!url.pathname.startsWith(PREVIEW_PROXY_PREFIX)) return undefined
  const segments = url.pathname.split("/")
  const port = parseInt(segments[4] ?? "", 10)
  if (!port || port < 1 || port > 65535) return undefined
  return { port, path: "/" + segments.slice(5).join("/") + url.search }
}

export function proxyBase(port: number): string {
  return `${PREVIEW_PROXY_PREFIX}${port}/`
}

// Rebase absolute-path asset URLs (e.g. Vite's `/@vite/client`, `/src/main.tsx`)
// onto the preview proxy path and anchor relative URLs with a <base> tag. Inline
// module scripts and styles are rewritten too: a <base> tag does not affect
// root-absolute specifiers inside inline code or CSS, so `import "/@react-refresh"`
// or `url(/asset.png)` would otherwise resolve against the origin root and bypass
// the proxy.
export function rewritePreviewHtml(body: string, base: string): string {
  let html = body.replace(/(\b(?:src|href)=")\/(?!\/)/g, (_m, prefix) => `${prefix}${base}`)
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs: string, code: string) => {
    if (!code || !/\btype\s*=\s*["']module["']/i.test(attrs)) return match
    return `<script${attrs}>${rewritePreviewModule(code, base)}</script>`
  })
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs: string, css: string) => {
    if (!css || !/url\(\s*["']?\//.test(css)) return match
    return `<style${attrs}>${css.replace(/url\(\s*(["']?)\/(?!\/)/g, `url($1${base}`)}</style>`
  })
  if (!/<base\b/i.test(html)) {
    const withBase = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}><base href="${base}">`)
    html = withBase === html ? `<base href="${base}">` + html : withBase
  }
  return html
}

// Rebase absolute-path module specifiers (e.g. Vite's `/src/main.tsx`,
// `/node_modules/.vite/deps/react.js`, `/@vite/client`, `/@fs/...`) onto the
// preview proxy path. Dev servers normalize every import to a root-absolute URL,
// which would otherwise resolve against the origin root and bypass the proxy.
// Only module-specifier positions are touched (`from`, `import`, `import(`,
// `new URL(..., import.meta.url)`) so ordinary string literals like client-side
// route paths are left alone.
function rewritePreviewModule(body: string, base: string, modulePath?: string): string {
  const rewritten = body
    .replace(/(\bfrom\s*["'])\/(?!\/)/g, `$1${base}`)
    .replace(/(\bimport\s*(?:\(\s*)?["'])\/(?!\/)/g, `$1${base}`)
    .replace(/(\bnew\s+URL\s*\(\s*["'])\/(?!\/)/g, `$1${base}`)
  return /^\/@vite\/client(?:[?#]|$)/.test(modulePath ?? "") ? rewriteViteHmrSocket(rewritten, base) : rewritten
}

// Vite derives its HMR socket host from `import.meta.url` but drops the path,
// so the default client dials the main origin root (`ws://host:port/`) and never
// reaches the proxy prefix. Point both the primary and direct-fallback sockets at
// the proxy base so HMR works even when the browser cannot reach the dev-server
// port directly (remote/central). Version-defensive: if the injected client
// shape changes, leave it untouched and Vite's own fallback still applies.
function rewriteViteHmrSocket(body: string, base: string) {
  return body
    .replace(/const socketHost = `[^`]*`;/, `const socketHost = \`$\{location.host}${base}\`;`)
    .replace(/const directSocketHost = "[^"]*";/, `const directSocketHost = \`$\{location.host}${base}\`;`)
    .replace(/const base = [^;]*;/, `const base = ${JSON.stringify(base)};`)
}

// Preview proxy requests run inside the HttpApi app (short-circuiting the UI
// catch-all) so that exactly one request listener responds; the raw Node server
// callback only handles paths the app never sees. HTML/JS payloads are buffered
// and rewritten so absolute asset URLs resolve through the proxy path; everything
// else streams through untouched. Nothing may be cached: preview ports are stable
// but their content changes on every edit. Dev-server HMR WebSockets are bridged
// at the router middleware and, for Vite, the client is rewritten to dial the
// proxy base instead of the main origin root. Preview
// dev servers gzip responses, but the app's fetch-based HttpClient transparently
// decompresses those bodies (while leaving `content-encoding` behind), so the
// buffered bytes are always plain text; the stale encoding/framing headers are
// stripped below.
export function previewProxyResponse(
  client: HttpClient.HttpClient,
  request: HttpServerRequest.HttpServerRequest,
  target: { port: number; path: string },
  bridge?: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> {
  const url = `http://localhost:${target.port}${target.path}`
  const base = proxyBase(target.port)
  const host = { host: `localhost:${target.port}` }
  return Effect.gen(function* () {
    const upstreamHeaders = ProxyUtil.headers(request.headers as HeadersInit, host)
    upstreamHeaders.delete("cookie")
    upstreamHeaders.delete("authorization")
    const response = yield* client.execute(
      HttpClientRequest.make(request.method as never)(url, {
        headers: upstreamHeaders,
        body: requestBody(request),
      }),
    )
    const contentType = response.headers["content-type"] ?? ""
    const isHtml = contentType.includes("text/html")
    const isJavaScript = /javascript/.test(contentType)
    if (isHtml || isJavaScript) {
      const chunks = yield* response.stream.pipe(Stream.runCollect)
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      const rewritten = isHtml
        ? rewritePreviewHtml(body.toString("utf8"), base) +
          (bridge
            ? `<script id="omai-visual-bridge" data-omai-visual-bridge>${bridge.replace(/<\/script/gi, "<\\/script")}</script>`
            : "")
        : rewritePreviewModule(body.toString("utf8"), base, target.path)
      const headers = new Headers(response.headers as HeadersInit)
      headers.delete("set-cookie")
      headers.delete("clear-site-data")
      headers.delete("content-encoding")
      headers.delete("content-length")
      headers.delete("transfer-encoding")
      headers.set("cache-control", "no-store")
      return HttpServerResponse.uint8Array(Buffer.from(rewritten), {
        status: response.status,
        statusText: statusText(response),
        headers,
      })
    }
    const headers = new Headers(response.headers as HeadersInit)
    headers.delete("set-cookie")
    headers.delete("clear-site-data")
    headers.delete("content-encoding")
    headers.delete("content-length")
    headers.delete("transfer-encoding")
    headers.set("cache-control", "no-store")
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      statusText: statusText(response),
      headers,
    })
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 502 }))))
}

function statusText(response: unknown) {
  return (response as { source?: Response }).source?.statusText
}
