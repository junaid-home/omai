import { useAuth } from "@/context/auth"
import type { SettingsPermissionKey } from "@/utils/central-state"

/** Visibility gates for server-backed settings. Unauthenticated (local) installs see everything. */
export function useSettingsPermission() {
  const auth = useAuth()
  return {
    isAdmin: () => (auth.user()?.role ?? "member") === "admin",
    can: (scope: SettingsPermissionKey) => auth.user()?.settingsPermissions?.[scope] ?? true,
  }
}