// Existing browser fixtures exercise standalone storage with a verified session.
// Keep bootstrap explicit so an unknown endpoint cannot accidentally become auth.
export const mockAuthUser = { id: "user-e2e", username: "e2e", email: "e2e@example.test" }

export const localAuthRoutes: Record<string, unknown> = {
  "/auth/config": { mode: "local" },
  "/auth/me": mockAuthUser,
}

export function mockCorsHeaders() {
  return {
    "access-control-allow-origin": new URL(
      process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`,
    ).origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Content-Type, Authorization, X-Opencode-Directory, X-Opencode-Workspace, X-Opencode-User-ID",
  }
}
