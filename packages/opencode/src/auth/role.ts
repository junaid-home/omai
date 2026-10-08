import type { Role } from "@opencode-ai/core/user/permissions"

export function adminUsernames() {
  return (process.env.OPENCODE_ADMIN_USERNAME ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

/** The stored role can be upgraded by an explicit environment override. */
export function effectiveRole(username: string, stored: Role | null | undefined): Role {
  return adminUsernames().includes(username) ? "admin" : (stored ?? "member")
}