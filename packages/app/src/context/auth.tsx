import { createContext, createEffect, onCleanup, type ParentProps, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/context/server"
import { centralRuntime, type AuthUser } from "@/utils/central-state"
import { signupInvitation } from "@/utils/signup-invitation"

interface AuthContextValue {
  user: () => AuthUser | null
  token: () => string | null
  isAuthenticated: () => boolean
  loading: () => boolean
  login: (usernameOrEmail: string, password: string) => Promise<{ error?: string }>
  signup: (username: string, email: string, password: string, inviteToken?: string) => Promise<{ error?: string }>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>()

export function AuthProvider(props: ParentProps) {
  const server = useServer()
  const [state, setState] = createStore({
    user: centralRuntime.get().user ?? (null as AuthUser | null),
    loading: centralRuntime.get().mode !== "central",
  })

  createEffect(() => {
    const url = server.current?.http.url
    if (centralRuntime.get().mode === "central") return
    setState({ user: null, loading: true })
    if (!url) {
      setState("loading", false)
      return
    }
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void fetch(`${url}/auth/me`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as AuthUser) : null))
      .then((user) => {
        if (!controller.signal.aborted)
          setState({ user: user ? { ...user, model: user.model ?? null } : null, loading: false })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ user: null, loading: false })
      })
  })

  const authenticate = async (route: "login" | "signup", body: Record<string, string>): Promise<{ error?: string }> => {
    const url = centralRuntime.get().mode === "central" ? centralRuntime.get().url : server.current?.http.url
    if (!url) return { error: "Server not available" }
    try {
      const response = await fetch(`${url}/auth/${route}`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const result = await response.json()
      if (!response.ok) return { error: result.error || "Authentication failed" }
      if (centralRuntime.get().mode === "central") {
        // A new document creates fresh providers bound to the verified cookie identity.
        window.location.assign("/")
        return {}
      }
      setState("user", result.user)
      return {}
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Network error" }
    }
  }
  const logout = async () => {
    const runtime = centralRuntime.get()
    const url = runtime.mode === "central" ? runtime.url : server.current?.http.url
    if (!url) throw new Error("Server not available")
    // Do not lose unsaved drafts on logout or claim revocation when the server is unavailable.
    await runtime.client?.flush()
    const response = await fetch(`${url}/auth/logout`, {
      method: "POST",
      credentials: "include",
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error("Logout could not be confirmed. Please retry.")
    runtime.client?.dispose()
    setState("user", null)
  }
  return (
    <AuthContext.Provider
      value={{
        user: () => state.user,
        token: () => null,
        isAuthenticated: () => !!state.user,
        loading: () => state.loading,
        login: (usernameOrEmail, password) => authenticate("login", { usernameOrEmail, password }),
        signup: (username, email, password, inviteToken) => {
          const invitation = centralRuntime.get().mode === "central" ? (inviteToken ?? signupInvitation()) : inviteToken
          return authenticate("signup", {
            username,
            email,
            password,
            ...(invitation ? { inviteToken: invitation } : {}),
          })
        },
        logout,
      }}
    >
      {props.children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

/** Auth context when available, otherwise null (e.g. isolated component previews). */
export function useAuthOptional(): AuthContextValue | null {
  return useContext(AuthContext) ?? null
}
