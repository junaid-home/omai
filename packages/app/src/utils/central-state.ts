/** A server-owned, optimistic-concurrency storage adapter. Unsaved values live only in memory. */
export type StateNamespace =
  | "preferences"
  | "drafts"
  | "comments"
  | "history"
  | "notifications"
  | "permissions"
  | "workspace"
  | "ui"

export type StateAddress = { namespace: StateNamespace; key: string }
export type StateRevision = { revision: number; value: string | null }
export type StateStatus = "loading" | "saved" | "pending" | "error" | "conflict"
export type StateSnapshot = StateAddress & {
  status: StateStatus
  revision: number
  value: string | null
  remote?: StateRevision
  error?: string
}

type Entry = {
  address: StateAddress
  committed?: StateRevision
  desired?: { value: string | null }
  status: StateStatus
  remote?: StateRevision
  error?: string
  load?: Promise<string | null>
  task?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  failures?: number
  retryAt?: number
  listeners: Set<(value: string | null) => void>
}

export class StateConflictError extends Error {
  constructor(readonly current: StateRevision) {
    super("This item changed in another browser. Choose which version to keep.")
    this.name = "StateConflictError"
  }
}

export function stateAddress(target: { storage?: string; key: string }): StateAddress {
  const name = target.key.split("\u0000").at(-1) ?? target.key
  const namespace: StateNamespace = /(^|:)comments$/.test(name)
    ? "comments"
    : /(^|:)prompt$/.test(name)
      ? "drafts"
      : /history/.test(name)
        ? "history"
        : /notification/.test(name)
          ? "notifications"
          : /permission/.test(name)
            ? "permissions"
            : /^(settings|model|language|theme)|model-selection|launch/.test(name)
              ? "preferences"
              : name.startsWith("workspace:") || name.startsWith("session:")
                ? "workspace"
                : "ui"
  // JSON tuples are reversible and escape the NUL separators in existing server-scoped keys.
  return { namespace, key: JSON.stringify([target.storage ?? "", target.key]) }
}

export function createCentralState(input: {
  url: string
  userID: string
  fetch: typeof fetch
  debounceMs?: number
  timeoutMs?: number
}) {
  // Native browser fetch rejects an arbitrary options object as its receiver.
  const requestFetch = input.fetch
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  const pendingChecks = new Set<() => boolean>()
  const abort = new AbortController()
  const endpoint = new URL("user-state", input.url.replace(/\/?$/, "/"))
  const keyOf = (address: StateAddress) => JSON.stringify([address.namespace, address.key])
  const notify = () => listeners.forEach((listener) => listener())
  const entryFor = (address: StateAddress) => {
    const key = keyOf(address)
    const found = entries.get(key)
    if (found) return found
    const entry: Entry = { address, status: "loading", listeners: new Set() }
    entries.set(key, entry)
    return entry
  }
  const active = () => {
    if (abort.signal.aborted) throw new Error("This user session is no longer active.")
  }
  const request = async (address: StateAddress, change?: StateRevision) => {
    active()
    const url = new URL(endpoint)
    if (!change) {
      url.searchParams.set("namespace", address.namespace)
      url.searchParams.set("key", address.key)
    }
    const response = await requestFetch(url, {
      method: change ? "PUT" : "GET",
      credentials: "include",
      cache: "no-store",
      headers: { "X-Opencode-User-ID": input.userID, ...(change ? { "Content-Type": "application/json" } : {}) },
      body: change ? JSON.stringify({ ...address, expectedRevision: change.revision, value: change.value }) : undefined,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(input.timeoutMs ?? 15_000)]),
    })
    active()
    if (!response.ok && response.status !== 409) {
      throw new Error(
        response.status === 401
          ? "Your session expired. Sign in again to save."
          : `Central storage request failed (${response.status}).`,
      )
    }
    const result: unknown = await response.json()
    if (
      !result ||
      typeof result !== "object" ||
      !("revision" in result) ||
      !("value" in result) ||
      !Number.isSafeInteger(result.revision) ||
      Number(result.revision) < 0 ||
      (result.value !== null && typeof result.value !== "string")
    ) {
      throw new Error("The server returned an invalid storage revision.")
    }
    const revision: StateRevision = { revision: Number(result.revision), value: result.value }
    if (response.status === 409) throw new StateConflictError(revision)
    return revision
  }
  const failed = (entry: Entry, error: unknown) => {
    entry.status = error instanceof StateConflictError ? "conflict" : "error"
    entry.error = error instanceof Error ? error.message : "Central storage is unavailable."
    entry.remote = error instanceof StateConflictError ? error.current : undefined
    entry.failures = (entry.failures ?? 0) + 1
    entry.retryAt = Date.now() + Math.min(5_000 * 2 ** (entry.failures - 1), 300_000)
    notify()
  }
  const load = (entry: Entry): Promise<string | null> => {
    active()
    if (entry.committed) return Promise.resolve(entry.desired ? entry.desired.value : entry.committed.value)
    if (entry.load) return entry.load
    entry.status = "loading"
    entry.load = request(entry.address)
      .then((current) => {
        entry.committed = current
        entry.status = entry.desired ? "pending" : "saved"
        entry.error = undefined
        entry.failures = undefined
        entry.retryAt = undefined
        notify()
        return entry.desired ? entry.desired.value : current.value
      })
      .catch((error: unknown) => {
        failed(entry, error)
        throw error
      })
      .finally(() => {
        entry.load = undefined
      })
    return entry.load
  }
  const drain = (entry: Entry): Promise<void> => {
    active()
    if (entry.task) return entry.task
    entry.task = (async () => {
      await load(entry)
      while (entry.desired) {
        active()
        if (entry.status === "conflict") throw new StateConflictError(entry.remote!)
        const desired = entry.desired
        if (entry.committed?.value === desired.value) {
          entry.desired = undefined
          continue
        }
        const previous = entry.committed!
        entry.status = "pending"
        notify()
        const current = await request(entry.address, { revision: previous.revision, value: desired.value }).catch(
          (error: unknown) => {
            // A lost acknowledgement can be reconciled without blindly overwriting a newer value.
            if (error instanceof StateConflictError && error.current.value === desired.value) return error.current
            throw error
          },
        )
        if (current.value !== desired.value || current.revision <= previous.revision) {
          throw new Error("The server did not acknowledge the saved value.")
        }
        entry.committed = current
        if (entry.desired === desired) entry.desired = undefined
        entry.error = undefined
        entry.remote = undefined
      }
      entry.status = "saved"
      entry.failures = undefined
      entry.retryAt = undefined
      notify()
    })()
      .catch((error: unknown) => {
        failed(entry, error)
        throw error
      })
      .finally(() => {
        entry.task = undefined
      })
    return entry.task
  }
  const schedule = (entry: Entry, value: string | null) => {
    active()
    if (entry.status === "saved" && !entry.desired && entry.committed?.value === value) return
    entry.desired = { value }
    entry.listeners.forEach((listener) => listener(value))
    if (entry.status !== "conflict") entry.status = "pending"
    notify()
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (entry.status !== "conflict") void drain(entry).catch(() => undefined)
    }, input.debounceMs ?? 250)
  }
  const snapshots = (): StateSnapshot[] =>
    [...entries.values()].map((entry) => ({
      ...entry.address,
      status: entry.status,
      revision: entry.committed?.revision ?? 0,
      value: entry.desired ? entry.desired.value : (entry.committed?.value ?? null),
      remote: entry.remote,
      error: entry.error,
    }))
  const retry = async (address: StateAddress) => {
    const entry = entryFor(address)
    if (entry.status === "conflict") throw new StateConflictError(entry.remote!)
    if (entry.desired) return drain(entry)
    entry.committed = undefined
    await load(entry)
    entry.listeners.forEach((listener) => listener(entry.committed!.value))
  }
  const resolve = async (address: StateAddress, choice: "local" | "remote") => {
    const entry = entryFor(address)
    if (entry.status !== "conflict" || !entry.remote) return
    entry.committed = entry.remote
    entry.remote = undefined
    entry.error = undefined
    entry.status = "saved"
    if (choice === "remote") {
      entry.desired = undefined
      entry.listeners.forEach((listener) => listener(entry.committed!.value))
      notify()
      return
    }
    await drain(entry)
  }
  let refreshing: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing
    const task: Promise<void> = (async () => {
      await Promise.all(
        [...entries.values()]
          .filter((entry) => entry.status === "saved" && !entry.task && !entry.load && entry.listeners.size > 0)
          .map(async (entry) => {
            const before = entry.committed
            const current = await request(entry.address).catch((error: unknown) => {
              failed(entry, error)
              throw error
            })
            if (entry.status !== "saved" || entry.desired || entry.committed !== before) return
            if (current.revision === before?.revision) return
            entry.committed = current
            entry.listeners.forEach((listener) => listener(current.value))
            notify()
          }),
      )
    })().finally(() => {
      refreshing = undefined
    })
    refreshing = task
    return task
  }
  return {
    url: input.url,
    userID: input.userID,
    snapshots,
    trackPending(check: () => boolean) {
      pendingChecks.add(check)
      return () => {
        pendingChecks.delete(check)
      }
    },
    invalidate(address: StateAddress, error: unknown) {
      const entry = entryFor(address)
      entry.committed = undefined
      failed(entry, error)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    watch(address: StateAddress, listener: (value: string | null) => void) {
      const entry = entryFor(address)
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0 && !entry.desired && !entry.task && entry.status !== "conflict")
          entry.committed = undefined
      }
    },
    storage(address: StateAddress) {
      const entry = entryFor(address)
      return {
        getItem: (_key: string) => load(entry),
        // Solid's storage primitive does not await writes. Rejections are represented by snapshots.
        setItem: async (_key: string, value: string) => {
          schedule(entry, value)
        },
        removeItem: async (_key: string) => {
          schedule(entry, null)
        },
      }
    },
    async flush(address?: StateAddress) {
      const selected = address ? [entryFor(address)] : [...entries.values()]
      await Promise.all(
        selected.map((entry) => {
          if (entry.timer) clearTimeout(entry.timer)
          entry.timer = undefined
          if (entry.desired) return drain(entry)
          return entry.load
        }),
      )
      if ([...pendingChecks].some((check) => check()))
        throw new Error("State is still loading. Your changes have not been saved.")
    },
    retry,
    resolve,
    recover() {
      const now = Date.now()
      for (const entry of entries.values()) {
        if (entry.status === "conflict") {
          void resolve(entry.address, "local").catch(() => undefined)
          continue
        }
        if (entry.status !== "error") continue
        if (entry.listeners.size === 0 && !entry.desired) continue
        if (entry.retryAt !== undefined && now < entry.retryAt) continue
        void retry(entry.address).catch(() => undefined)
      }
    },
    refresh,
    dirty: () => [...entries.values()].some((entry) => !!entry.desired) || [...pendingChecks].some((check) => check()),
    dispose() {
      abort.abort()
      refreshing = undefined
      entries.forEach((entry) => {
        if (entry.timer) clearTimeout(entry.timer)
      })
      listeners.clear()
      pendingChecks.clear()
    },
  }
}

export type CentralState = ReturnType<typeof createCentralState>
export type SettingsPermissionKey =
  | "mcp"
  | "models"
  | "providers"
  | "servers"
  | "shortcuts"
  | "general"
  | "terminal"
  | "fileTree"
  | "context"
  | "mestro"
  | "sessions"
  | "sessionNavigation"
export type AuthModel = { providerID: string; modelID: string }
export type AuthUser = {
  id: string
  username: string
  email: string
  role: "admin" | "member"
  settingsPermissions: Record<SettingsPermissionKey, boolean>
  model: AuthModel | null
}

export function fullSettingsPermissions(): Record<SettingsPermissionKey, boolean> {
  return {
    mcp: true,
    models: true,
    providers: true,
    servers: true,
    shortcuts: true,
    general: true,
    terminal: true,
    fileTree: true,
    context: true,
    mestro: true,
    sessions: true,
    sessionNavigation: true,
  }
}

function isSettingsPermissions(value: unknown): value is Record<SettingsPermissionKey, boolean> {
  if (!value || typeof value !== "object") return false
  const keys = [
    "mcp",
    "models",
    "providers",
    "servers",
    "shortcuts",
    "general",
    "terminal",
    "fileTree",
    "context",
    "mestro",
    "sessions",
    "sessionNavigation",
  ]
  return keys.every((key) => typeof (value as Record<string, unknown>)[key] === "boolean")
}

function isAuthModel(value: unknown): value is AuthModel {
  if (!value || typeof value !== "object") return false
  return typeof (value as AuthModel).providerID === "string" && typeof (value as AuthModel).modelID === "string"
}

type Runtime = {
  mode: "local" | "central"
  url?: string
  workspaceRoot?: string
  projectsRoot?: string
  google?: boolean
  user?: AuthUser
  client?: CentralState
}
const runtime: Runtime = { mode: "local" }
const anonymous = new Map<string, string>()

export const centralRuntime = {
  get: () => runtime,
  configure(input: Runtime) {
    runtime.client?.dispose()
    anonymous.clear()
    Object.assign(
      runtime,
      { url: undefined, workspaceRoot: undefined, projectsRoot: undefined, google: undefined, user: undefined, client: undefined },
      input,
    )
  },
  anonymousStorage(address: StateAddress) {
    const key = JSON.stringify(address)
    return {
      getItem: async (_key: string) => anonymous.get(key) ?? null,
      setItem: async (_key: string, value: string) => {
        anonymous.set(key, value)
      },
      removeItem: async (_key: string) => {
        anonymous.delete(key)
      },
    }
  },
}

export async function bootstrapCentralState(input: { url: string; fetch: typeof fetch; requireCentral?: boolean }) {
  const requestFetch = input.fetch
  const base = input.url.replace(/\/+$/, "")
  const response = await requestFetch(`${base}/auth/config`, {
    credentials: "include",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error("The server storage mode could not be verified. Reconnect to continue.")
  const config: unknown = await response.json()
  if (
    !config ||
    typeof config !== "object" ||
    !("mode" in config) ||
    (config.mode !== "local" && config.mode !== "central")
  ) {
    throw new Error("The server returned an invalid storage mode.")
  }
  if (input.requireCentral && config.mode !== "central")
    throw new Error("This deployment requires central server storage.")
  const projectsRoot =
    "projectsRoot" in config && typeof config.projectsRoot === "string"
      ? config.projectsRoot.replace(/\/+$/, "")
      : undefined
  if (config.mode === "local") {
    centralRuntime.configure({ mode: "local", url: base, projectsRoot })
    return
  }
  const workspaceRoot =
    "workspaceRoot" in config && typeof config.workspaceRoot === "string"
      ? config.workspaceRoot.replace(/\/+$/, "")
      : undefined
  const google = "google" in config && config.google === true
  const session = await requestFetch(`${base}/auth/me`, {
    credentials: "include",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (session.status === 401) {
    centralRuntime.configure({ mode: "central", url: base, workspaceRoot, projectsRoot, google })
    return
  }
  if (!session.ok) throw new Error("Your server session could not be verified. Reconnect to continue.")
  const user: unknown = await session.json()
  if (
    !user ||
    typeof user !== "object" ||
    !("id" in user) ||
    typeof user.id !== "string" ||
    !("username" in user) ||
    typeof user.username !== "string" ||
    !("email" in user) ||
    typeof user.email !== "string" ||
    !("role" in user) ||
    (user.role !== "admin" && user.role !== "member") ||
    !("settingsPermissions" in user)
  ) {
    throw new Error("The server returned an invalid user session.")
  }
  const role: AuthUser["role"] = user.role
  const settingsPermissions = isSettingsPermissions(user.settingsPermissions)
    ? user.settingsPermissions
    : fullSettingsPermissions()
  const model = "model" in user && isAuthModel(user.model) ? user.model : null
  const identity: AuthUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    role,
    settingsPermissions,
    model,
  }
  centralRuntime.configure({
    mode: "central",
    url: base,
    workspaceRoot,
    google,
    user: identity,
    client: createCentralState({ url: base, userID: identity.id, fetch: requestFetch }),
  })
}
