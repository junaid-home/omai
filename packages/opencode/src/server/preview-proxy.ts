import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { requestBody } from "@/server/routes/instance/httpapi/middleware/proxy"
import { ProxyUtil } from "@/server/proxy-util"

const PREVIEW_PROXY_PREFIX = "/global/preview/proxy/"

export const PREVIEW_RELAY_HEADER = "x-opencode-preview-relay"

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

export function rewritePreviewHtml(body: string, base: string): string {
  let html = body.replace(/(\b(?:src|href)=")\/(?!\/)/g, (_m, prefix) => `${prefix}${base}`)
  if (!/<base\b/i.test(html)) {
    const withBase = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}><base href="${base}">`)
    html = withBase === html ? `<base href="${base}">` + html : withBase
  }
  return html
}

function rewritePreviewModule(body: string, base: string): string {
  return body
    .replace(/(\bfrom\s*["'])\/(?!\/)/g, `$1${base}`)
    .replace(/(\bimport\s*(?:\(\s*)?["'])\/(?!\/)/g, `$1${base}`)
    .replace(/(\bnew\s+URL\s*\(\s*["'])\/(?!\/)/g, `$1${base}`)
}

export function previewProxyResponse(
  client: HttpClient.HttpClient,
  request: HttpServerRequest.HttpServerRequest,
  target: { port: number; path: string },
  bridge?: string,
  upstream?: { origin: string; headers?: HeadersInit },
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> {
  const baseOrigin = upstream?.origin ?? `http://localhost:${target.port}`
  const url = upstream
    ? `${upstream.origin}/global/preview/proxy/${target.port}${target.path}`
    : `http://localhost:${target.port}${target.path}`
  const base = proxyBase(target.port)
  return Effect.gen(function* () {
    const dial = new Headers(upstream?.headers)
    if (upstream) dial.set(PREVIEW_RELAY_HEADER, "1")
    const upstreamHeaders = ProxyUtil.headers(request.headers as HeadersInit, { host: new URL(baseOrigin).host })
    upstreamHeaders.delete("cookie")
    upstreamHeaders.delete("authorization")
    for (const [key, value] of dial.entries()) upstreamHeaders.set(key, value)
    const relay = request.headers[PREVIEW_RELAY_HEADER] !== undefined
    const response = yield* client.execute(
      HttpClientRequest.make(request.method as never)(url, {
        headers: upstreamHeaders,
        body: requestBody(request),
      }),
    )
    const contentType = response.headers["content-type"] ?? ""
    const isHtml = !relay && contentType.includes("text/html")
    const isJavaScript = !relay && /javascript/.test(contentType)
    if (isHtml || isJavaScript) {
      const chunks = yield* response.stream.pipe(Stream.runCollect)
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      const rewritten = isHtml
        ? rewritePreviewHtml(body.toString("utf8"), base) +
          (bridge
            ? `<script id="omai-visual-bridge" data-omai-visual-bridge>${bridge.replace(/<\/script/gi, "<\\/script")}</script>`
            : "")
        : rewritePreviewModule(body.toString("utf8"), base)
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
