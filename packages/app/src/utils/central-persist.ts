import { batch, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { centralRuntime, stateAddress } from "./central-state"
import { normalize } from "./persist-normalize"

export function persistedCentral<T>(
  config: { storage?: string; key: string; migrate?: (value: unknown) => unknown },
  store: [Store<T>, SetStoreFunction<T>],
  defaults: unknown,
): [Store<T>, SetStoreFunction<T>, Promise<string>, Accessor<boolean> & { promise: Promise<string> }] {
  const client = centralRuntime.get().client
  const address = stateAddress(config)
  const storage = client?.storage(address) ?? centralRuntime.anonymousStorage(address)
  const [hydration, setHydration] = createStore({ ready: false })
  const queued: unknown[][] = []
  const initialized = Promise.withResolvers<string>()
  if (client) onCleanup(client.trackPending(() => queued.length > 0))
  const apply = (raw: string | null) => {
    const value = raw === null ? JSON.stringify(defaults) : normalize(defaults, raw, config.migrate)
    if (value === undefined) throw new Error("The saved server state is invalid. It has not been overwritten.")
    const next = JSON.parse(value)
    batch(() => {
      // Existing editors observe an array reference after local input, so replace changed arrays
      // before reconciling other fields. Unchanged branches retain their reactive identity.
      if (next && typeof next === "object" && !Array.isArray(next))
        store[1]((previous) => ({
          ...previous,
          ...Object.fromEntries(
            Object.entries(next).filter(
              ([key, value]) =>
                Array.isArray(value) &&
                JSON.stringify(value) !== JSON.stringify((previous as Record<string, unknown>)[key]),
            ),
          ),
        }))
      store[1](reconcile(next))
    })
    const pending = queued.splice(0)
    pending.forEach((args) => (store[1] as (...args: unknown[]) => unknown)(...args))
    setHydration("ready", true)
    if (pending.length) void storage.setItem(config.key, JSON.stringify(store[0])).catch(() => undefined)
    initialized.resolve(value)
    return value
  }
  const init = storage.getItem(config.key).then(apply)
  // The existing toast and dialog expose hydration failures and retry; no local fallback and no unhandled rejection.
  void init.catch((error: unknown) => client?.invalidate(address, error))
  if (client)
    onCleanup(
      client.watch(address, (raw) => {
        try {
          apply(raw)
        } catch (error) {
          client.invalidate(address, error)
          throw error
        }
      }),
    )
  const setState = ((...args: unknown[]) => {
    if (!hydration.ready) queued.push(args)
    const result = (store[1] as (...args: unknown[]) => unknown)(...args)
    if (hydration.ready) void storage.setItem(config.key, JSON.stringify(store[0])).catch(() => undefined)
    return result
  }) as SetStoreFunction<T>
  return [
    store[0],
    setState,
    initialized.promise,
    Object.assign(() => hydration.ready, { promise: initialized.promise }),
  ]
}
