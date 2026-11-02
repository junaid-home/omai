export function errorDescriptionKey(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "localServerStartup" in error &&
    error.localServerStartup === true
  ) {
    return "error.page.description.localServerStartup" as const
  }
  return "error.page.description" as const
}

// The server answers 404 for anything that does not exist and for another
// user's project or session alike. The client error keeps the status in its
// cause chain.
export function isNotFoundError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false
  if ("status" in error && error.status === 404) return true
  return "cause" in error && isNotFoundError(error.cause, depth + 1)
}
