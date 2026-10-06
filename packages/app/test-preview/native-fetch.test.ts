import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"

test("native browser fetch verifies central identity and persists a draft", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("native-fetch-harness.ts", import.meta.url).pathname],
    target: "browser",
  })
  if (!build.success) throw new Error(build.logs.map(String).join("\n"))
  const script = await build.outputs[0].text()
  const requests: string[] = []
  let revision = 0
  let value: string | null = null
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } })
      if (path === "/auth/config")
        return Response.json({ mode: "central" }, { headers: { "Set-Cookie": "session=test; Path=/; HttpOnly" } })
      if (path === "/auth/me") {
        if (request.headers.get("cookie") !== "session=test") return new Response(null, { status: 401 })
        return Response.json({ id: "browser-user", username: "browser", email: "browser@example.test" })
      }
      if (path === "/user-state") {
        if (
          request.headers.get("cookie") !== "session=test" ||
          request.headers.get("x-opencode-user-id") !== "browser-user"
        )
          return new Response(null, { status: 401 })
        requests.push(request.method)
        if (request.method === "PUT") {
          const change = await request.json()
          if (change.expectedRevision !== revision) return Response.json({ revision, value }, { status: 409 })
          revision++
          value = change.value
        }
        return Response.json({ revision, value })
      }
      return new Response('<html><script src="/harness.js"></script></html>', {
        headers: { "Content-Type": "text/html" },
      })
    },
  })
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCODE_TEST_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  })
  try {
    const page = await browser.newPage()
    await page.goto(server.url.toString())
    await page.waitForFunction(() => !!window.stateRoundTrip)
    expect(await page.evaluate(() => window.stateRoundTrip())).toEqual({
      initial: null,
      saved: "Saved through native browser fetch",
    })
    expect(requests).toEqual(["GET", "PUT", "GET"])
    expect(revision).toBe(1)
  } finally {
    await browser.close()
    server.stop(true)
  }
})
