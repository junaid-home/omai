import { readFileSync } from "node:fs"
import { Context, Effect } from "effect"
import type { Role, SettingsPermissions } from "./user/permissions"

/** A user authenticated for one deployment-owned instance, not a filesystem capability. */
export type Principal = {
  readonly userID: string
  readonly sessionID: string
  readonly instanceID: string
  readonly username: string
  readonly email: string
  readonly role: Role
  readonly settingsPermissions: SettingsPermissions
}

export const Current = Context.Reference<Principal | undefined>("@opencode/Authentication/Current", {
  defaultValue: () => undefined,
})

export interface Interface {
  readonly authenticate: (token: string) => Effect.Effect<Principal | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Authentication") {}

export function secret(name: string) {
  const inline = process.env[name]
  const file = process.env[`${name}_FILE`]
  if (inline && file) throw new Error(`${name} and ${name}_FILE are mutually exclusive`)
  if (!file) return inline
  const value = readFileSync(file, "utf8").trim()
  if (!value || Buffer.byteLength(value) > 16_384) throw new Error(`${name}_FILE contains an invalid secret`)
  return value
}

export function central() {
  const mode = process.env.OPENCODE_AUTH_MODE
  if (mode && mode !== "local" && mode !== "central") throw new Error("OPENCODE_AUTH_MODE must be local or central")
  if (process.env.OPENCODE_STORAGE_MODE === "central") {
    if (mode === "local") throw new Error("Central storage requires central authentication")
    return true
  }
  return mode
    ? mode === "central"
    : Boolean(process.env.OPENCODE_DATABASE_URL || process.env.OPENCODE_DATABASE_URL_FILE)
}

/** Local authentication is only appropriate for a process bound to loopback. */
export function validateListener(hostname: string) {
  if (central()) return
  if (!["127.0.0.1", "::1", "localhost"].includes(hostname)) {
    throw new Error(
      "Local authentication requires a loopback listener; configure central authentication for network access",
    )
  }
}

export function instanceID() {
  const value = process.env.OPENCODE_INSTANCE_ID
  if (!central()) return value || "local"
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Central authentication requires a valid OPENCODE_INSTANCE_ID")
  }
  return value
}

export function publicOrigin() {
  const value = process.env.OPENCODE_PUBLIC_URL
  if (!value) {
    if (central()) throw new Error("Central authentication requires OPENCODE_PUBLIC_URL")
    return undefined
  }
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("OPENCODE_PUBLIC_URL must be an origin without credentials, path, query or fragment")
  }
  if (central() && url.protocol !== "https:") {
    throw new Error("Central authentication requires an HTTPS OPENCODE_PUBLIC_URL")
  }
  return url.origin
}

export * as Authentication from "./authentication"
