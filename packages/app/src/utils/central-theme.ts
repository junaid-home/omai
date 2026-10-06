import { centralRuntime, stateAddress } from "./central-state"

/** Theme choices are durable preferences; generated CSS remains a reconstructable in-memory cache. */
export async function prepareCentralTheme() {
  if (centralRuntime.get().mode !== "central") return
  const client = centralRuntime.get().client
  const address = stateAddress({ key: "theme" })
  const adapter = client?.storage(address) ?? centralRuntime.anonymousStorage(address)
  const raw = await adapter.getItem(address.key)
  const choices = new Set(["opencode-theme-id", "opencode-color-scheme"])
  const parsed: unknown = raw === null ? {} : JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Saved theme preferences are invalid.")
  const values = new Map<string, string>(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => choices.has(entry[0]) && typeof entry[1] === "string",
    ),
  )
  const listeners = new Set<(key: string, value: string | null) => void>()
  client?.watch(address, (value) => {
    const next: Record<string, string> = value === null ? {} : JSON.parse(value)
    choices.forEach((key) => {
      const current = typeof next[key] === "string" ? next[key] : null
      if (current === values.get(key)) return
      if (current === null) values.delete(key)
      else values.set(key, current)
      listeners.forEach((listener) => listener(key, current))
    })
  })
  const save = () =>
    adapter.setItem(address.key, JSON.stringify(Object.fromEntries([...values].filter(([key]) => choices.has(key)))))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (values.get(key) === value) return
      values.set(key, value)
      if (choices.has(key)) void save().catch(() => undefined)
    },
    removeItem(key: string) {
      if (!values.delete(key)) return
      if (choices.has(key)) void save().catch(() => undefined)
    },
    subscribe(listener: (key: string, value: string | null) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
