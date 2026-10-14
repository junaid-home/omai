import type { AuthModel, AuthUser } from "./central-state"

export const LOCKED_MODEL_LABEL = "OMAI+"

/** The admin-assigned model lock. Admins and unassigned members stay unrestricted. */
export function assignedModel(user: AuthUser | null | undefined): AuthModel | null {
  if (!user) return null
  if (user.role === "admin") return null
  return user.model ?? null
}

export function isModelLocked(user: AuthUser | null | undefined): boolean {
  return assignedModel(user) !== null
}
