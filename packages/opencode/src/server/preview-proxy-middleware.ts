import { Authentication } from "@opencode-ai/core/authentication"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { getVmPreviewTarget } from "@/control-plane/vm-preview-map"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { visualBridgeScript } from "@/preview/visual-bridge"
import { previewProxyResponse, previewProxyTarget } from "@/server/preview-proxy"

// Preview proxy requests must be answered by exactly one listener. The raw Node
// server callback and effect's request listener both fire on the same http.Server,
// so proxying preview traffic here short-circuits the UI catch-all instead of
// racing it (either responder can win, serving the wrong app). Everything else
// flows through. Preview has no HMR/websocket bridging: a manual refresh of the
// preview picks up the latest build from the dev server.
//
// On the control plane a `workspace` query parameter turns this into a two-hop
// proxy: browser -> control plane -> the workspace MicroVM's own preview proxy
// -> the dev server, so the iframe stays same-origin with the app. Inside a
// workspace VM (or a local install) the same middleware proxies directly to
// localhost, which is the second hop.
export const previewProxyHttpMiddleware = HttpRouter.middleware<{
  handles: unknown
  requires: HttpClient.HttpClient | Workspace.Service
}>()(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const workspace = yield* Workspace.Service
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const target = previewProxyTarget(url)
        if (!target) return yield* effect
        // Control plane without a workspace: no MicroVM to reach and the local
        // dev-server branch must not run here (there is none on this host).
        if (
          Authentication.central() &&
          !process.env["OPENCODE_WORKSPACE_ID"] &&
          !url.searchParams.get("workspace") &&
          !previewWorkspaceCookie(request, target.port)
        )
          return HttpServerResponse.empty({ status: 404 })
        const workspaceID = url.searchParams.get("workspace") ?? previewWorkspaceCookie(request, target.port)
        const hadQuery = url.searchParams.has("workspace")
        if (!workspaceID) return yield* previewProxyResponse(client, request, target)
        const upstream = yield* resolveUpstream(workspace, workspaceID)
        if (!upstream) return HttpServerResponse.empty({ status: 404 })
        url.searchParams.delete("workspace")
        const hop = previewProxyTarget(url) ?? target
        const response = yield* previewProxyResponse(client, request, hop, visualBridgeScript(Authentication.publicOrigin()!), {
          origin: upstream.url,
          headers: upstream.headers,
        })
        if (hadQuery) {
          const cookie = `omai_preview_route_${target.port}=${workspaceID}; Path=/global/preview/proxy/${target.port}; HttpOnly; SameSite=Lax${Authentication.central() ? "; Secure" : ""}`
          return HttpServerResponse.setHeaders(response, { "set-cookie": cookie })
        }
        return response
      })
  }),
).layer

// Workspace routing records the target on every request it sends to a MicroVM,
// which covers preview traffic in practice (the panel sends directory-scoped
// requests first). Fall back to resolving through the workspace service so a
// stale process-local map never strands the preview.
function resolveUpstream(
  workspace: Workspace.Interface,
  workspaceID: string,
): Effect.Effect<{ url: string; headers?: HeadersInit } | undefined> {
  const cached = getVmPreviewTarget(workspaceID)
  if (cached) return Effect.succeed(cached)
  return Effect.gen(function* () {
    const id = Schema.decodeUnknownOption(WorkspaceV2.ID)(workspaceID)
    if (Option.isNone(id)) return undefined
    const info = yield* workspace.get(id.value)
    if (!info) return undefined
    const target = yield* WorkspaceAdapterRuntime.targetOrGone(info).pipe(
      Effect.catchTag("WorkspaceGone", () => Effect.succeed(undefined)),
    )
    if (!target || target.type !== "remote") return undefined
    return { url: String(target.url), ...(target.headers ? { headers: target.headers } : {}) }
  })
}

function previewWorkspaceCookie(request: HttpServerRequest.HttpServerRequest, port: number): string | undefined {
  const name = `omai_preview_route_${port}`
  const raw = request.headers.cookie ?? ""
  for (const part of raw.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1)
  }
  return undefined
}

export * as PreviewProxyMiddleware from "./preview-proxy-middleware"
