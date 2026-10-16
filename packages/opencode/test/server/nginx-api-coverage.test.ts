import { describe, expect, test } from "bun:test"
import path from "node:path"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "@/server/routes/instance/httpapi/public"

// nginx proxies API traffic through an explicit allowlist of top-level path
// segments. A missing segment does not 404: the request falls through to the
// SPA fallback and returns index.html, so the client fails with
// "Unexpected token '<'". This guards both nginx configs against drifting from
// the API groups they must forward.
const ROOT = path.join(import.meta.dir, "..", "..", "..", "..")
const CONFIGS = [path.join(ROOT, "nginx.conf"), path.join(ROOT, "k8s", "configmap-nginx.yml")]

function proxyLocationPattern(text: string) {
  const line = text.split("\n").find((entry) => entry.includes("location ~ ^/("))
  if (!line) throw new Error("API proxy location not found")
  const trimmed = line.trim()
  return new RegExp(trimmed.slice("location ~ ".length, trimmed.lastIndexOf(" {")))
}

function apiSegments() {
  const spec = OpenApi.fromApi(PublicApi)
  return [
    ...new Set(
      Object.keys(spec.paths ?? {})
        .map((routePath) => routePath.split("/")[1])
        .filter((segment): segment is string => !!segment),
    ),
  ].sort()
}

describe("nginx API proxy allowlist", () => {
  test("both configs proxy every API top-level segment", async () => {
    const segments = apiSegments()
    expect(segments.length).toBeGreaterThan(0)
    for (const config of CONFIGS) {
      const pattern = proxyLocationPattern(await Bun.file(config).text())
      const missing = segments.filter(
        (segment) => !pattern.test(`/${segment}`) && !pattern.test(`/${segment}/probe`),
      )
      expect({ config, missing }).toEqual({ config, missing: [] })
    }
  })
})
