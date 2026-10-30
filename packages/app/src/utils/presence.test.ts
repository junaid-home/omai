import { afterEach, describe, expect, test } from "bun:test"
import { engaged, markActive, visible } from "./presence"

const setVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })

afterEach(() => setVisibility("visible"))

describe("presence", () => {
  test("a visible tab with recent input is engaged until four minutes pass", () => {
    setVisibility("visible")
    markActive(1_000)
    expect(engaged(1_000 + 3 * 60_000)).toBe(true)
    expect(engaged(1_000 + 4 * 60_000)).toBe(false)
  })

  test("a hidden tab is never engaged, however recent its input", () => {
    markActive(1_000)
    setVisibility("hidden")
    expect(visible()).toBe(false)
    expect(engaged(1_001)).toBe(false)
  })

  test("user input and returning to the tab both count as activity", () => {
    setVisibility("visible")
    markActive(0)
    window.dispatchEvent(new Event("keydown"))
    expect(engaged()).toBe(true)

    markActive(0)
    document.dispatchEvent(new Event("visibilitychange"))
    expect(engaged()).toBe(true)
  })
})
