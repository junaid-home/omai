import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import type { Accessor } from "solid-js"
import { createMemo } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"

export const popularProviders = ["anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]
const popularProviderSet = new Set(popularProviders)

// OpenCode Zen and Go stay registered so existing configs and in-flight sessions
// keep resolving, but they are withheld from every provider list the UI renders.
const hiddenProviderSet = new Set(["opencode", "opencode-go"])

export function useProviders(directory?: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))
  const providers = createMemo(() => {
    const value = dir()
    const projectStore = value ? serverSync().child(value)[0] : undefined
    const catalog = directory
      ? selectProviderCatalog({
          explicit: true,
          directory: value,
          catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
        })
      : selectProviderCatalog({
          explicit: false,
          directory: value,
          catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
          global: serverSync().data.provider,
        })
    return {
      ...catalog,
      all: new Map([...catalog.all].filter(([id]) => !hiddenProviderSet.has(id))),
      connected: catalog.connected.filter((id) => !hiddenProviderSet.has(id)),
    }
  })
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      // The old `id !== "opencode"` cost guard is moot: opencode never reaches `all`.
      return [...Iterable.filter(providers().all, ([id]) => connected.has(id))]
    },
  }
}
