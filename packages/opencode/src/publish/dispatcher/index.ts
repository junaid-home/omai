import { PlatformName } from "../platform-name"

type Env = {
  DISPATCHER: { get(name: string): { fetch(r: Request): Promise<Response> } }
  HOSTNAMES: { get(k: string): Promise<string | null> }
}

export async function dispatch(request: Request, env: Env, zone: string) {
  const host = new URL(request.url).hostname.toLowerCase()
  const script = PlatformName.resolveScript(host, zone) ?? (await env.HOSTNAMES.get(host))
  if (!script) return notFound()
  // `get` may throw synchronously, so it runs inside the same promise chain as `fetch`.
  return Promise.resolve()
    .then(() => env.DISPATCHER.get(script).fetch(request))
    .catch((e: unknown) => {
      if (e instanceof Error && /worker not found|worker has been deleted/i.test(e.message)) return notFound()
      throw e
    })
}

function notFound() {
  return new Response("Not found", { status: 404 })
}

export default {
  fetch: (request: Request, env: Env & { ZONE: string }) => dispatch(request, env, env.ZONE),
}
