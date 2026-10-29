export * as PlatformName from "./platform-name"

import { Effect } from "effect"

export const RESERVED: ReadonlySet<string> = new Set([
  "app",
  "preview",
  "view",
  "www",
  "live",
  "web",
  "autoconfig",
  "autodiscover",
  "fallback",
  "dispatch",
  "omai-dispatcher",
])

const MAX = 40
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

export function slug(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX)
      .replace(/-+$/g, "") || "site"
  )
}

export function withSuffix(base: string) {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => ALPHABET[byte % ALPHABET.length]).join(
    "",
  )
  return `${base.slice(0, MAX - 5).replace(/-+$/g, "")}-${random}`
}

export function choose(input: string, taken: (name: string) => Effect.Effect<boolean, Error>) {
  return Effect.gen(function* () {
    const base = slug(input)
    if (!RESERVED.has(base) && !(yield* taken(base))) return base
    for (let attempt = 0; attempt < 5; attempt++) {
      const name = withSuffix(base)
      if (!RESERVED.has(name) && !(yield* taken(name))) return name
    }
    return yield* Effect.fail(new Error(`Could not find an available app name for "${input}"`))
  })
}

export function resolveScript(host: string, zone: string) {
  const suffix = `.${zone.toLowerCase()}`
  const name = host.toLowerCase()
  if (!name.endsWith(suffix)) return undefined
  const label = name.slice(0, -suffix.length)
  if (!label || label.includes(".") || RESERVED.has(label)) return undefined
  return label
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** Lowercase hostname with at least two labels; each label is 1-63 chars of [a-z0-9-] without edge hyphens. */
export function isHostname(input: string) {
  return input.length <= 253 && input.includes(".") && input.split(".").every((label) => LABEL.test(label))
}

/** Decides a freshly written claim tag read-back: another project's tag means taken; missing or foreign tags are treated as stale reads. */
export function claimOutcome(owner: string | undefined, projectID: string): "ours" | "taken" | "unknown" {
  if (owner === projectID) return "ours"
  if (owner?.startsWith("omai-project-")) return "taken"
  return "unknown"
}
