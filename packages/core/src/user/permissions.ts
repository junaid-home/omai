import { Schema } from "effect"

export const Role = Schema.Literals(["admin", "member"])
export type Role = Schema.Schema.Type<typeof Role>

export const SettingsScope = Schema.Literals([
  "general",
  "terminal",
  "fileTree",
  "shortcuts",
  "servers",
  "providers",
  "models",
  "mcp",
])
export type SettingsScope = Schema.Schema.Type<typeof SettingsScope>

export const settingsScopes = [
  "general",
  "terminal",
  "fileTree",
  "shortcuts",
  "servers",
  "providers",
  "models",
  "mcp",
] as const satisfies readonly SettingsScope[]

export type SettingsPermissions = Record<SettingsScope, boolean>
export type RawSettingsPermissions = Partial<SettingsPermissions>

export const SettingsPermissionsSchema = Schema.Record(SettingsScope, Schema.Boolean)

export function fullSettingsPermissions(): SettingsPermissions {
  return Object.fromEntries(settingsScopes.map((scope) => [scope, true])) as SettingsPermissions
}

/** Stored permissions are a partial override over the all-allowed default. */
export function effectiveSettingsPermissions(
  stored: RawSettingsPermissions | null | undefined,
  admin = false,
): SettingsPermissions {
  if (admin) return fullSettingsPermissions()
  const merged = fullSettingsPermissions()
  for (const scope of settingsScopes) {
    const allowed = stored?.[scope]
    if (allowed !== undefined) merged[scope] = allowed
  }
  return merged
}