// The control plane pauses a project's MicroVM once it has had no requests for
// OPENCODE_WORKSPACE_IDLE_MS (5 minutes). The app's keep-alive heartbeats are
// requests too, so they must stop when nobody is at the tab: otherwise a
// forgotten background tab keeps every opened project's VM running for good.
// A VM still doing work (an agent turn, a build) reports itself busy and stays
// up on its own.
const ENGAGED_MS = 4 * 60_000
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const

const state = { last: Date.now() }

/** Records that the user just interacted with the page. */
export function markActive(now = Date.now()) {
  state.last = now
}

/** Whether the page is on screen. */
export function visible() {
  return typeof document === "undefined" || document.visibilityState === "visible"
}

/** Whether the page is on screen and the user has interacted with it recently. */
export function engaged(now = Date.now()) {
  return visible() && now - state.last < ENGAGED_MS
}

if (typeof window !== "undefined") {
  INPUT_EVENTS.forEach((type) => window.addEventListener(type, () => markActive(), { capture: true, passive: true }))
  // Coming back to the tab counts as using it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") markActive()
  })
}
