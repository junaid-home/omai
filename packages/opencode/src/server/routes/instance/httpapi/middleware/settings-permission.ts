import { Authentication } from "@opencode-ai/core/authentication"
import type { SettingsScope } from "@opencode-ai/core/user/permissions"
import { Effect } from "effect"
import { ForbiddenError } from "../errors"

/**
 * Gate a server-backed settings mutation behind the caller's role and settings
 * permissions. Unauthenticated (local install) callers are always allowed so the
 * single machine owner keeps full control without a user registry.
 */
export const requireSettingsScope = Effect.fn("Authorization.requireSettingsScope")(function* (scope: SettingsScope) {
  const principal = yield* Authentication.Current
  if (!principal || principal.role === "admin") return
  if (principal.settingsPermissions[scope]) return
  return yield* new ForbiddenError({ message: `Settings permission "${scope}" is required` })
})