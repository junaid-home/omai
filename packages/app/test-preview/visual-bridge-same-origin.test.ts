import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "@playwright/test"
import { visualBridgeScript } from "../../opencode/src/preview/visual-bridge"
import type { createVisualBridge } from "../src/utils/visual-bridge"

declare global {
  interface Window {
    editor: ReturnType<typeof createVisualBridge>
  }
}

// MicroVM previews have no dedicated origin: the control plane proxies them on
// the app's own origin under /global/preview/proxy/<port>.
let browser: Browser
let page: Page
const main = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Starting") })

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("harness.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser", "development"],
    minify: false,
  })
  if (!build.success) throw new Error(build.logs.map(String).join("\n"))
  const script = await build.outputs[0].text()
  main.reload({
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/harness.js")
        return new Response(script, { headers: { "Content-Type": "text/javascript" } })
      if (url.pathname.startsWith("/global/preview/proxy/5173"))
        return new Response(
          `<html><body><h1 id="headline">Original heading</h1><script id="omai-visual-bridge" data-omai-visual-bridge>${visualBridgeScript(main.url.origin)}</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        )
      return new Response(
        `<html><body><iframe title="Preview" style="width:900px;height:650px" src="/global/preview/proxy/5173/?workspace=wrk_test" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe><script src="/harness.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      )
    },
  })
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCODE_TEST_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  })
  page = await browser.newPage()
  await page.goto(main.url.toString())
  await page.waitForFunction(() => !!window.editor)
})
afterAll(async () => {
  await browser?.close()
  main.stop(true)
})

describe("visual editor on a same-origin MicroVM preview", () => {
  test("connects and selects elements", async () => {
    await page.frameLocator("iframe").locator("#headline").click()
    await page.waitForFunction(() => window.editor.selectedElement()?.cssSelector === "#headline")
    expect(await page.evaluate(() => window.editor.bridgeError())).toBe("")
  })
})
