// The control plane pauses a project's MicroVM once it has had no requests for
// OPENCODE_WORKSPACE_IDLE_MS (5 minutes). The app's keep-alive heartbeats are
// requests too, so they must stop when nobody is at the tab: otherwise a
// forgotten background tab keeps every opened project's VM running for good.
// A VM still doing work (an agent turn, a build) reports itself busy and stays
// up on its own.
const ENGAGED_MS = 4 * 60_000
/** A user idle this long, with no agent running, is signed out. */
export const IDLE_LOGOUT_MS = 10 * 60_000
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const
// Every tab shares one sign-in, so one tab must not sign the user out while
// they are working in another: the last activity is shared through storage.
const SHARED_KEY = "omai.presence.last"
const SHARE_EVERY_MS = 15_000

const state = { last: Date.now(), shared: 0 }

/** Records that the user just interacted with the page. */
export function markActive(now = Date.now()) {
  state.last = now
  if (now - state.shared < SHARE_EVERY_MS) return
  state.shared = now
  if (typeof localStorage !== "undefined") localStorage.setItem(SHARED_KEY, String(now))
}

/** Whether the page is on screen. */
export function visible() {
  return typeof document === "undefined" || document.visibilityState === "visible"
}

/** Whether the page is on screen and the user has interacted with it recently. */
export function engaged(now = Date.now()) {
  return visible() && now - state.last < ENGAGED_MS
}

/** How long since the user last interacted with any tab of the app. */
export function idleFor(now = Date.now()) {
  const shared = typeof localStorage === "undefined" ? 0 : Number(localStorage.getItem(SHARED_KEY))
  return now - Math.max(state.last, shared || 0)
}

if (typeof window !== "undefined") {
  INPUT_EVENTS.forEach((type) => window.addEventListener(type, () => markActive(), { capture: true, passive: true }))
  // Coming back to the tab counts as using it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") markActive()
  })
}
