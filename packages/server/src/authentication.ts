import { CentralStorage } from "@opencode-ai/core/storage/central"
import { Authentication } from "@opencode-ai/core/authentication"
import { Effect, FileSystem, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

export const SESSION_COOKIE = "omai_session"

export function requestToken(headers: Readonly<Record<string, string | undefined>>) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(headers.authorization ?? "")
  if (bearer) return { token: bearer[1], cookie: false }
  if (headers.authorization?.toLowerCase().startsWith("bearer")) return undefined
  const cookies = (headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
  if (cookies.length !== 1) return undefined
  const token = cookies[0].slice(SESSION_COOKIE.length + 1)
  if (!token || token.length > 8192 || /[\s,;]/.test(token)) return undefined
  return { token, cookie: true }
}

export function sessionCookie(token: string, maxAge: number) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${Authentication.central() ? "; Secure" : ""}`
}

export function sameOrigin(request: { method: string; headers: Readonly<Record<string, string | undefined>> }) {
  const origin = Authentication.publicOrigin()
  if (!origin) return true
  const mutates =
    !["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.upgrade?.toLowerCase() === "websocket"
  if (!mutates) return true
  if (request.headers.origin) return request.headers.origin === origin
  return !requestToken(request.headers)?.cookie
}

export function publicRequest(method: string, pathname: string) {
  if (method === "POST" && ["/auth/login", "/auth/signup"].includes(pathname)) return true
  if (method !== "GET" && method !== "HEAD") return false
  if (
    [
      "/auth/config",
      "/auth/google",
      "/auth/google/callback",
      "/global/health",
      "/global/live",
      "/",
      "/login",
      "/signup-secret-route",
      "/favicon.ico",
      "/site.webmanifest",
      "/web-app-manifest-192x192.png",
      "/web-app-manifest-512x512.png",
    ].includes(pathname)
  )
    return true
  return pathname.startsWith("/assets/")
}

/** Transport boundary for the combined legacy/v2 server, including raw media and preview routes. */
export const middleware = HttpRouter.middleware(
  Effect.gen(function* () {
    if (!Authentication.central()) return (effect) => effect
    Authentication.instanceID()
    Authentication.publicOrigin()
    const service = yield* Effect.serviceOption(Authentication.Service)
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const limit =
          url.pathname === "/global/file/create"
            ? 256 * 1024 * 1024
            : url.pathname === "/user-state"
              ? 16 * 1024 * 1024
              : url.pathname.startsWith("/preview/thumbnail/")
                ? 3 * 1024 * 1024
                : 16 * 1024 * 1024
        const bounded = effect.pipe(Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(limit)))
        if (!sameOrigin(request)) return HttpServerResponse.empty({ status: 403 })
        if (publicRequest(request.method, url.pathname)) return yield* bounded
        // CORS preflight cannot execute endpoint handlers. The CORS transport middleware answers it.
        if (request.method === "OPTIONS") return HttpServerResponse.empty({ status: 204 })
        const token = requestToken(request.headers)
        if (!token || Option.isNone(service)) return HttpServerResponse.empty({ status: 401 })
        const principal = yield* service.value.authenticate(token.token)
        if (!principal) return HttpServerResponse.empty({ status: 401 })
        const directories = [
          url.searchParams.get("directory"),
          url.searchParams.get("location[directory]"),
          request.headers["x-opencode-directory"],
        ].filter((value): value is string => Boolean(value))
        for (const value of directories) {
          const safe = yield* Effect.tryPromise(() => CentralStorage.resolveWorkspace(decodeURIComponent(value))).pipe(
            Effect.option,
          )
          if (Option.isNone(safe)) return HttpServerResponse.empty({ status: 403 })
        }
        return yield* bounded.pipe(Effect.provideService(Authentication.Current, principal))
      })
  }),
  { global: true },
)

export * as AuthenticationHttp from "./authentication"
