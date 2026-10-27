import type { Plugins } from "@dnd-kit/abstract"
import { Accessibility, AutoScroller, Feedback, ScrollListener, Scroller, StyleInjector } from "@dnd-kit/dom"

// @dnd-kit/solid reassigns `manager.plugins` from an effect, which can run after the
// provider already destroyed its manager (e.g. when a project's stream connects late and
// the tab strip remounts). The base setter only registers what it is given, so AutoScroller
// would be constructed without Scroller and throw. Listing the DOM core plugins first keeps
// them registered before their dependents in every case.
export function tabStripPlugins(defaults: Plugins): Plugins {
  return [
    ScrollListener,
    Scroller,
    StyleInjector,
    ...(Array.isArray(defaults) ? defaults : []).filter((plugin) => plugin && plugin !== Accessibility),
    AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
    Feedback.configure({ dropAnimation: null }),
  ]
}
