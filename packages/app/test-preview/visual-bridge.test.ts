import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "@playwright/test"
import { visualBridgeScript } from "../../opencode/src/preview/visual-bridge"
import type { createVisualBridge } from "../src/utils/visual-bridge"

declare global {
  interface Window {
    editor: ReturnType<typeof createVisualBridge>
    channel: string
  }
}

let browser: Browser
let page: Page
const main = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Starting") })
const preview = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Starting") })
const errors: string[] = []

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
      if (new URL(request.url).pathname === "/harness.js")
        return new Response(script, { headers: { "Content-Type": "text/javascript" } })
      return new Response(
        `<html><body><iframe title="Preview" style="width:900px;height:650px" src="${preview.url}" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe><script src="/harness.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      )
    },
  })
  preview.reload({
    fetch: () =>
      new Response(
        `<html><head><style>body{margin:30px}#headline{display:block;width:260px;height:60px;margin:0}#picture{width:80px;height:60px}</style></head><body><h1 id="headline">Original heading</h1><p id="paragraph">Description</p><svg id="picture" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg><script>window.addEventListener('message',function(e){if(e.data.type==='omai:visual:init')window.channel=e.data.channel})</script><script id="omai-visual-bridge" data-omai-visual-bridge>${visualBridgeScript(main.url.origin)}</script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      ),
  })
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCODE_TEST_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(main.url.toString())
  await page.waitForFunction(() => !!window.editor)
  await page.frameLocator("iframe").locator("#headline").click()
  await page.waitForFunction(() => window.editor.selectedElement()?.cssSelector === "#headline")
})
afterAll(async () => {
  await browser?.close()
  main.stop(true)
  preview.stop(true)
})

describe("isolated visual editor in Chromium", () => {
  test("keeps actual preview DOM inaccessible to the parent", async () => {
    expect(await page.evaluate(() => document.querySelector("iframe")?.contentDocument)).toBeNull()
    expect(await page.evaluate(() => window.editor.selectedElement()?.textContent)).toBe("Original heading")
  })

  test("applies text and CSS in the preview and returns an explicit clean save snapshot", async () => {
    await page.evaluate(() => {
      window.editor.applyCssProperty("color", "rgb(200, 0, 0)")
      window.editor.recordTextChange("Edited heading")
    })
    await page.waitForFunction(() =>
      window.editor.pendingChanges().some((change) => change.type === "text" && change.content === "Edited heading"),
    )
    expect(await page.frameLocator("iframe").locator("#headline").textContent()).toBe("Edited heading")
    expect(
      await page
        .frameLocator("iframe")
        .locator("#headline")
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(200, 0, 0)")
    const html = await page.evaluate(() => window.editor.collectModifiedHtml())
    expect(html).toContain("Edited heading")
    expect(html).not.toContain("omai-visual-bridge")
    expect(html).not.toContain("data-omai-visual-control")
  })

  test("supports pointer drag and resize within the isolated document", async () => {
    const headline = page.frameLocator("iframe").locator("#headline")
    const box = (await headline.boundingBox())!
    await page.mouse.move(box.x + 50, box.y + 30)
    await page.mouse.down()
    await page.mouse.move(box.x + 85, box.y + 45, { steps: 4 })
    await page.mouse.up()
    await page.waitForFunction(() => window.editor.pendingChanges().some((change) => change.type === "style"))
    expect(await headline.evaluate((el) => getComputedStyle(el).transform)).not.toBe("none")
    const before = await headline.evaluate((el) => el.getBoundingClientRect().width)
    const handle = (await page.frameLocator("iframe").locator('[data-resize="e"]').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2, { steps: 4 })
    await page.mouse.up()
    expect(await headline.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(before + 25)
  })

  test("preserves inline text editing and Escape cancellation", async () => {
    const headline = page.frameLocator("iframe").locator("#headline")
    await headline.dblclick()
    await page.waitForFunction(() => window.editor.inlineEditing())
    await headline.fill("Inline edit")
    await headline.press("Enter")
    await page.waitForFunction(
      () =>
        !window.editor.inlineEditing() &&
        window.editor.pendingChanges().some((change) => change.type === "text" && change.content === "Inline edit"),
    )
    expect(await headline.textContent()).toBe("Inline edit")
    await headline.dblclick()
    await headline.fill("Cancelled edit")
    await headline.press("Escape")
    await page.waitForFunction(() => !window.editor.inlineEditing())
    expect(await headline.textContent()).toBe("Inline edit")
    expect(
      await page.evaluate(() => window.editor.pendingChanges().find((change) => change.type === "text")?.content),
    ).toBe("Inline edit")
  })

  test("replaces an SVG image and validates message origin and source", async () => {
    await page.frameLocator("iframe").locator("#picture").click()
    await page.waitForFunction(() => window.editor.selectedElement()?.imageKind === "svg")
    await page.evaluate(() =>
      window.editor.replaceImageSource("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"),
    )
    await page.waitForFunction(() => window.editor.selectedElement()?.imageKind === "img")
    const channel = await page
      .frames()
      .find((frame) => frame.url().startsWith(preview.url.origin))!
      .evaluate(() => window.channel)
    const before = await page.evaluate(() => window.editor.pendingChanges().length)
    await page.evaluate(
      (token) =>
        window.postMessage(
          {
            type: "omai:visual:state",
            channel: token,
            selected: null,
            hovered: null,
            changes: [],
            isEditing: false,
            inlineEditing: false,
            editingText: "",
          },
          location.origin,
        ),
      channel,
    )
    // Wait for the posted event task, without fixed timing assumptions.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(await page.evaluate(() => window.editor.pendingChanges().length)).toBe(before)
    expect(await page.evaluate(() => window.editor.selectedElement()?.imageKind)).toBe("img")
    const active = page.frames().find((frame) => frame.url().startsWith(preview.url.origin))!
    await active.evaluate(
      (origin) =>
        parent.postMessage(
          {
            type: "omai:visual:state",
            channel: "stale-channel-123456789",
            selected: null,
            hovered: null,
            changes: [],
            isEditing: false,
            inlineEditing: false,
            editingText: "",
          },
          origin,
        ),
      main.url.origin,
    )
    await page.evaluate((url) => {
      const iframe = document.createElement("iframe")
      iframe.id = "spoof"
      iframe.src = url
      document.body.appendChild(iframe)
    }, preview.url.toString())
    await page.frameLocator("#spoof").locator("#picture").waitFor()
    await page
      .frames()
      .find((frame) => frame !== active && frame.url().startsWith(preview.url.origin))!
      .evaluate(
        ({ token, origin }) =>
          parent.postMessage(
            {
              type: "omai:visual:state",
              channel: token,
              selected: null,
              hovered: null,
              changes: [],
              isEditing: false,
              inlineEditing: false,
              editingText: "",
            },
            origin,
          ),
        { token: channel, origin: main.url.origin },
      )
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(await page.evaluate(() => window.editor.pendingChanges().length)).toBe(before)
    expect(await page.evaluate(() => window.editor.selectedElement()?.imageKind)).toBe("img")
    expect(errors).toEqual([])
  })
})
