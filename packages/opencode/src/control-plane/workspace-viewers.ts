// Which workspaces each signed-in browser has recently used, so the control
// plane relays a VM's streamed tokens only to the browsers viewing it instead
// of every connected tab. Keyed by login session: a browser's event stream and
// its proxied requests carry the same one.
const TTL_MS = 6 * 60 * 60 * 1000
const seen = new Map<string, number>()
const pruned = { at: 0 }

const key = (loginSessionID: string, workspaceID: string) => `${loginSessionID}\n${workspaceID}`

export function view(loginSessionID: string, workspaceID: string) {
  const now = Date.now()
  seen.set(key(loginSessionID, workspaceID), now)
  if (now - pruned.at < 60_000) return
  pruned.at = now
  seen.forEach((at, entry) => {
    if (now - at >= TTL_MS) seen.delete(entry)
  })
}

export function viewing(loginSessionID: string, workspaceID: string) {
  const at = seen.get(key(loginSessionID, workspaceID))
  return at !== undefined && Date.now() - at < TTL_MS
}

// Message content only an open session renders. Streamed tokens are the bulk
// of all traffic, and part updates carry whole tool outputs; a tab that never
// used the VM loads the finished messages from it instead.
const CONTENT = new Set(["message.part.delta", "message.part.updated", "message.part.removed"])

/**
 * Whether a tab signed in as `loginSessionID` (none for machine or local
 * clients) receives a bus event.
 */
export function relays(
  loginSessionID: string | undefined,
  event: { readonly workspace?: string; readonly payload: { readonly type?: string } },
) {
  if (!loginSessionID) return true
  // Durable sync events feed the control plane's machine-authenticated sync
  // loop; every app, TUI and CLI client discards them.
  if (event.payload.type === "sync") return false
  if (!event.workspace || !CONTENT.has(event.payload.type ?? "")) return true
  return viewing(loginSessionID, event.workspace)
}

export * as WorkspaceViewers from "./workspace-viewers"
