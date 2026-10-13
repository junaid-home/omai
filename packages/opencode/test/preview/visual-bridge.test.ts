import { describe, expect, test } from "bun:test"
import { visualBridgeScript } from "../../src/preview/visual-bridge"

const APP_ORIGIN = "https://app.example.com"
const PREVIEW_ORIGIN = "https://preview.example.com"

function boot(links: string[]) {
  const posted: Array<Record<string, unknown>> = []
  const parent = { postMessage: (data: Record<string, unknown>) => posted.push(data) }
  const anchors = links.map((href) => ({
    getAttribute: (name: string) => (name === "href" ? href : null),
  }))
  const document = {
    documentElement: { nodeName: "HTML" },
    body: {},
    querySelectorAll: (selector: string) => (selector === "a[href]" ? anchors : []),
    addEventListener: () => {},
    createElement: () => {
      throw new Error("the bridge should not create elements before the visual editor is enabled")
    },
  }
  const location = { href: `${PREVIEW_ORIGIN}/`, origin: PREVIEW_ORIGIN }
  const window = { parent, location, addEventListener: () => {} }
  class MutationObserver {
    observe() {}
  }
  const globals = {
    window,
    document,
    location,
    parent,
    MutationObserver,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    CSS: { escape: (value: string) => value },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    Element: class {},
    DOMMatrix: class {},
  }
  const names = Object.keys(globals)
  const values = names.map((name) => (globals as Record<string, unknown>)[name])
  const script = visualBridgeScript(APP_ORIGIN).replace(/;$/, "")
  new Function(...names, `${script}\n`).apply(null, values)
  return { posted }
}

describe("visual bridge page discovery", () => {
  test("reports same-origin links to the parent without the visual editor", () => {
    const { posted } = boot([
      "/about",
      "/about",
      "/pricing.html",
      `${PREVIEW_ORIGIN}/contact/`,
      `${APP_ORIGIN}/leak`,
      "mailto:someone@example.com",
      "https://external.example.org/away",
    ])
    const pages = posted.find((message) => message.type === "omai:preview:pages")
    expect(pages).toBeDefined()
    expect(pages!.urls).toEqual([
      `${PREVIEW_ORIGIN}/about`,
      `${PREVIEW_ORIGIN}/pricing.html`,
      `${PREVIEW_ORIGIN}/contact/`,
    ])
    expect(posted.find((message) => message.type === "preview-ready")).toBeDefined()
  })

  test("sends no pages message when a page has no links", () => {
    const { posted } = boot([])
    expect(posted.find((message) => message.type === "preview-ready")).toBeDefined()
    expect(posted.find((message) => message.type === "omai:preview:pages")).toBeUndefined()
  })
})
