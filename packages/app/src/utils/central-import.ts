import { stateAddress, type AuthUser, type CentralState } from "./central-state"

type BrowserState = Pick<Storage, "length" | "key" | "getItem" | "removeItem">

/** Only offer an explicit import for a matching legacy account; never use it as authentication. */
export function matchingBrowserState(user: AuthUser, input: Storage | (() => Storage)): BrowserState | undefined {
  try {
    const source = typeof input === "function" ? input() : input
    const owner: unknown = JSON.parse(source.getItem("omai_auth_user") ?? "null")
    if (!owner || typeof owner !== "object" || !("id" in owner) || !("username" in owner)) return
    if (owner.id !== user.id || owner.username !== user.username) return
    const values = new Map(
      Array.from({ length: source.length }, (_, index) => source.key(index))
        .filter((key): key is string => key !== null && !!legacyTarget(key))
        .flatMap((key) => {
          const value = source.getItem(key)
          return value === null ? [] : [[key, value] as const]
        }),
    )
    if (!values.size) return
    // Capture the reviewed account's values now. Later changes by another tab are not imported or removed.
    return {
      get length() {
        return values.size
      },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      removeItem(key) {
        if (source.getItem(key) === values.get(key)) source.removeItem(key)
        values.delete(key)
      },
    }
  } catch {
    return
  }
}

function legacyTarget(name: string) {
  if (!name.startsWith("opencode.") && name !== "settings.v3") return
  const separator = name.indexOf(".dat:")
  const target =
    separator === -1 ? { key: name } : { storage: name.slice(0, separator + 4), key: name.slice(separator + 5) }
  const address = stateAddress(target)
  // Server connections contain credentials. Derived view caches are rebuilt rather than imported.
  if (!["preferences", "drafts", "comments", "history", "notifications", "permissions"].includes(address.namespace))
    return
  return { ...target, address }
}

/** Explicit, account-confirmed migration. Delete a browser copy only after its exact value commits. */
export async function importBrowserState(client: CentralState, source: BrowserState) {
  const names = Array.from({ length: source.length }, (_, index) => source.key(index)).filter(
    (key): key is string => key !== null,
  )
  const result = { imported: 0, existing: 0, failed: 0 }
  for (const name of names) {
    const target = legacyTarget(name)
    if (!target) continue
    const value = source.getItem(name)
    if (value === null) continue
    try {
      JSON.parse(value)
      const adapter = client.storage(target.address)
      await adapter.getItem(target.key)
      const current = client
        .snapshots()
        .find((entry) => entry.namespace === target.address.namespace && entry.key === target.address.key)
      if (!current || current.revision !== 0 || current.status !== "saved") {
        result.existing++
        continue
      }
      await adapter.setItem(target.key, value)
      await client.flush(target.address)
      if (source.getItem(name) === value) source.removeItem(name)
      result.imported++
    } catch {
      result.failed++
    }
  }
  return result
}
