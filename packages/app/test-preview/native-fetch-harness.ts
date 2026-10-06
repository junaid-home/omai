import { bootstrapCentralState, centralRuntime, createCentralState } from "../src/utils/central-state"

declare global {
  interface Window {
    stateRoundTrip: () => Promise<{ initial: string | null; saved: string | null }>
  }
}

window.stateRoundTrip = async () => {
  // Pass the actual browser function unbound, just as entry.tsx does.
  await bootstrapCentralState({ url: location.origin, fetch, requireCentral: true })
  const client = centralRuntime.get().client!
  const address = { namespace: "drafts" as const, key: "native-fetch" }
  const storage = client.storage(address)
  const initial = await storage.getItem(address.key)
  await storage.setItem(address.key, "Saved through native browser fetch")
  await client.flush()
  const reopened = createCentralState({ url: location.origin, userID: centralRuntime.get().user!.id, fetch })
  try {
    return { initial, saved: await reopened.storage(address).getItem(address.key) }
  } finally {
    client.dispose()
    reopened.dispose()
  }
}
