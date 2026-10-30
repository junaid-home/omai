// Per-browser-tab panel visibility (see the layout context).
export type TabPanels = {
  sidebar?: boolean
  mobileSidebar?: boolean
  terminal?: boolean
  review?: boolean
  fileTree?: boolean
}

// sessionStorage is private to one browser tab and survives its reloads.
const TAB_PANELS_KEY = "omai.layout.panels"

export function readTabPanels(storage: Pick<Storage, "getItem"> | undefined = tabStorage()): TabPanels {
  const raw = storage?.getItem(TAB_PANELS_KEY)
  if (!raw) return {}
  const parsed = parseJson(raw)
  if (!parsed || typeof parsed !== "object") return {}
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [keyof TabPanels, boolean] => typeof entry[1] === "boolean"),
  )
}

// A corrupted value must reset the panels, not break the whole layout.
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function writeTabPanels(value: TabPanels) {
  tabStorage()?.setItem(TAB_PANELS_KEY, JSON.stringify(value))
}

function tabStorage() {
  // Unavailable during SSR and in some privacy modes; panels then reset per load.
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage
}
